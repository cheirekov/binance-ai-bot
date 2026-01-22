import { placeOcoOrder, placeOrder } from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { loadState, persistLastTrade, persistPosition } from './persistence.js';
import { getStrategyResponse } from './strategyService.js';

const persisted = loadState();

export const autoTradeTick = async () => {
  if (!config.autoTradeEnabled) return;
  if (!config.tradingEnabled) {
    logger.warn('Auto-trade enabled but TRADING_ENABLED=false; skipping');
    return;
  }

  const state = getStrategyResponse();

  if (state.tradeHalted) {
    logger.info({ riskFlags: state.riskFlags }, 'Auto-trade blocked by risk flags');
    return;
  }
  const strategies = state.strategies;
  if (!strategies) {
    logger.info('Auto-trade skipped: no strategies yet');
    return;
  }

  const volPct =
    state.market && state.market.highPrice && state.market.lowPrice && state.market.price
      ? Math.abs((state.market.highPrice - state.market.lowPrice) / state.market.price) * 100
      : 0;

  const selectHorizon = () => {
    const candidates: { h: 'short' | 'medium' | 'long'; score: number }[] = [];
    (['short', 'medium', 'long'] as const).forEach((h) => {
      const plan = strategies[h];
      if (!plan) return;
      const entry = plan.entries[0];
      let score = entry.confidence; // 0-1
      score += plan.riskRewardRatio / 10; // modest boost for higher RR
      if (h === 'short' && volPct > 8) score += 0.1;
      if (h === 'medium' && volPct >= 4 && volPct <= 8) score += 0.05;
      if (h === 'long' && volPct < 4) score += 0.05;
      candidates.push({ h, score });
    });
    if (config.autoTradeHorizon && strategies[config.autoTradeHorizon]) {
      // prefer configured horizon unless another scores much higher
      const preferred = candidates.find((c) => c.h === config.autoTradeHorizon);
      const best = candidates.reduce((a, b) => (b.score > a.score ? b : a), candidates[0]);
      return best.score - (preferred?.score ?? 0) > 0.2 ? best.h : (config.autoTradeHorizon as
        | 'short'
        | 'medium'
        | 'long');
    }
    return candidates.reduce((a, b) => (b.score > a.score ? b : a), candidates[0]).h;
  };

  const chosenHorizon = selectHorizon();
  const plan = strategies[chosenHorizon];
  const entry = plan.entries[0];
  const positionKey = `${state.symbol}:${chosenHorizon}`;

  const openPosition = persisted.positions[positionKey];
  if (openPosition && state.market) {
    const markPnlPct =
      openPosition.side === 'BUY'
        ? (state.market.price - openPosition.entryPrice) / openPosition.entryPrice
        : (openPosition.entryPrice - state.market.price) / openPosition.entryPrice;
    const markPnlPct100 = markPnlPct * 100;
    if (markPnlPct100 <= -config.dailyLossCapPct) {
      logger.warn(
        { markPnlPct: markPnlPct100.toFixed(2) },
        'Auto-trade halted by daily loss cap',
      );
      return;
    }
  }

  if (entry.confidence < config.autoTradeMinConfidence) {
    logger.info(
      { confidence: entry.confidence, threshold: config.autoTradeMinConfidence },
      'Auto-trade skipped: low confidence',
    );
    return;
  }

  const key = `${state.symbol}:${chosenHorizon}`;
  const lastTrade = persisted.lastTrades[key] ?? 0;
  const cooldownMs = config.autoTradeCooldownMinutes * 60 * 1000;
  if (Date.now() - lastTrade < cooldownMs) {
    logger.info({ key }, 'Auto-trade cooldown active');
    return;
  }

  try {
    const order = await placeOrder({
      symbol: state.symbol,
      side: entry.side,
      quantity: entry.size,
      type: 'MARKET',
    });
    persistLastTrade(persisted, key, Date.now());
    persistPosition(persisted, positionKey, {
      symbol: state.symbol,
      horizon: chosenHorizon,
      side: entry.side,
      entryPrice: entry.priceTarget,
      size: entry.size,
      openedAt: Date.now(),
    });

    if (config.ocoEnabled) {
      try {
        await placeOcoOrder({
          symbol: state.symbol,
          side: entry.side === 'BUY' ? 'SELL' : 'BUY',
          quantity: entry.size,
          takeProfit: plan.exitPlan.takeProfit[0],
          stopLoss: plan.exitPlan.stopLoss,
        });
      } catch (error) {
        logger.warn({ err: error }, 'OCO placement failed; position left with manual exit');
      }
    }

    logger.info(
      { orderId: order?.orderId, symbol: state.symbol, horizon: chosenHorizon, volPct },
      'Auto-trade executed',
    );
  } catch (error) {
    logger.error({ err: error }, 'Auto-trade failed');
  }
};
