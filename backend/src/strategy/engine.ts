import { config } from '../config.js';
import { generateAiInsight } from '../ai/strategist.js';
import { persistMarketFeatures } from '../services/sqlite.js';
import { Horizon, MarketSnapshot, RiskSettings, Side, StrategyBundle, StrategyPlan } from '../types.js';
import { fetchIndicatorSnapshot, IndicatorSnapshot } from './indicators.js';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type SymbolRules = {
  tickSize?: number;
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
};

const mean = (values: number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);

const decimalsForStep = (step?: number): number => {
  if (!step) return 8;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1] ?? 8);
  const [, frac] = s.split('.');
  return frac ? frac.length : 0;
};

const floorToStep = (value: number, step?: number) => {
  if (!step) return value;
  const decimals = decimalsForStep(step);
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(decimals));
};

const pickTimeframe = (horizon: Horizon): number => {
  switch (horizon) {
    case 'short':
      return 120;
    case 'medium':
      return 24 * 60;
    case 'long':
    default:
      return 7 * 24 * 60;
  }
};

type Regime = 'TREND' | 'RANGE' | 'NEUTRAL';

const intervalForHorizon = (horizon: Horizon): string => {
  if (horizon === 'short') return '15m';
  if (horizon === 'medium') return '1h';
  return '4h';
};

const detectRegime = (indicators: IndicatorSnapshot): { regime: Regime; trendSide?: Side } => {
  const adx = indicators.adx14;
  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;

  if (adx === null || ema20 === null || ema50 === null) return { regime: 'NEUTRAL' };
  const aligned = ema20 !== ema50;

  if (adx > 20 && aligned) {
    return { regime: 'TREND', trendSide: ema20 > ema50 ? 'BUY' : 'SELL' };
  }
  if (adx < 18) return { regime: 'RANGE' };
  return { regime: 'NEUTRAL' };
};

const riskSizeBaseQty = (params: {
  entryPrice: number;
  stopLoss: number;
  quoteToHome: number;
  risk: RiskSettings;
  rules?: SymbolRules;
}): { qty: number; reason?: string } => {
  const { entryPrice, stopLoss, quoteToHome, risk, rules } = params;

  const stopDistance = Math.abs(entryPrice - stopLoss);
  const riskCapitalHome = risk.maxPositionSizeUsdt * risk.riskPerTradeFraction;
  const riskPerUnitHome = stopDistance * Math.max(quoteToHome, 0.00000001);
  const rawQty = riskPerUnitHome > 0 ? riskCapitalHome / riskPerUnitHome : 0;

  const maxQtyByNotional =
    risk.maxPositionSizeUsdt / Math.max(entryPrice * Math.max(quoteToHome, 0.00000001), 0.00000001);
  const slippageFactor = Math.max(0, 1 - config.slippageBps / 10000);
  const capped = clamp(rawQty * slippageFactor, 0, maxQtyByNotional);

  const stepped = floorToStep(capped, rules?.stepSize);

  if (!Number.isFinite(stepped) || stepped <= 0) return { qty: 0, reason: 'invalid_size' };
  if (rules?.minQty && stepped < rules.minQty) return { qty: 0, reason: 'below_min_qty' };
  if (rules?.minNotional && stepped * entryPrice < rules.minNotional) return { qty: 0, reason: 'below_min_notional' };
  return { qty: stepped };
};

const buildRegimePlan = (
  horizon: Horizon,
  market: MarketSnapshot,
  risk: RiskSettings,
  indicators: IndicatorSnapshot,
  aiNotes: string,
  newsSentiment: number,
  quoteToHome: number,
  rules?: SymbolRules,
): StrategyPlan => {
  const { regime, trendSide } = detectRegime(indicators);
  const price = Number.isFinite(market.price) && market.price > 0 ? market.price : indicators.close;
  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;
  const rsi = indicators.rsi14;
  const atr = indicators.atr14;
  const adx = indicators.adx14;
  const bb = indicators.bb20;

  const tick = rules?.tickSize;

  const trendEntryOk =
    regime === 'TREND' &&
    trendSide === 'BUY' &&
    ema20 !== null &&
    ema50 !== null &&
    rsi !== null &&
    atr !== null &&
    ema20 > ema50 &&
    rsi >= 45 &&
    rsi <= 70 &&
    Math.abs(price - ema20) <= 0.5 * atr;

  const rangeEntryOk =
    regime === 'RANGE' &&
    rsi !== null &&
    atr !== null &&
    bb.lower !== null &&
    bb.middle !== null &&
    rsi < 35 &&
    price <= bb.lower + 0.25 * (bb.middle - bb.lower);

  const side: Side = regime === 'TREND' && trendSide === 'SELL' ? 'SELL' : 'BUY';

  const entryPrice = tick ? floorToStep(price, tick) : price;

  let stopLoss: number | null = null;
  let takeProfit: number[] = [];
  let trailingNote: string | null = null;

  if (atr !== null) {
    if (trendEntryOk) {
      stopLoss = entryPrice - 1.5 * atr;
      takeProfit = [entryPrice + 2.5 * atr];
      trailingNote = 'Trail stop after +1*ATR (move to breakeven, then trail 1.5*ATR below best price)';
    } else if (rangeEntryOk) {
      stopLoss = entryPrice - 1.2 * atr;
      const atrPct = entryPrice > 0 ? atr / entryPrice : 0;
      const target =
        bb.middle !== null && bb.upper !== null
          ? atrPct < 0.015
            ? bb.middle
            : bb.upper
          : entryPrice + 1.6 * atr;
      takeProfit = [target];
    } else if (regime === 'TREND' && trendSide === 'SELL') {
      // Spot long-only: "SELL" means bearish bias / avoid longs; keep a conservative placeholder.
      stopLoss = entryPrice + 1.5 * atr;
      takeProfit = [entryPrice - 2.5 * atr];
    } else {
      stopLoss = entryPrice - 1.2 * atr;
      takeProfit = [entryPrice + 1.6 * atr];
    }
  }

  const roundedStop = stopLoss !== null && tick ? floorToStep(stopLoss, tick) : stopLoss;
  const roundedTp0 = takeProfit[0] !== undefined && tick ? floorToStep(takeProfit[0], tick) : takeProfit[0];
  const roundedTakeProfit = roundedTp0 !== undefined ? [roundedTp0] : [];

  const longDistancesOk =
    side === 'BUY' &&
    roundedStop !== null &&
    roundedTakeProfit[0] !== undefined &&
    roundedStop < entryPrice &&
    roundedTakeProfit[0] > entryPrice;
  const shortDistancesOk =
    side === 'SELL' &&
    roundedStop !== null &&
    roundedTakeProfit[0] !== undefined &&
    roundedStop > entryPrice &&
    roundedTakeProfit[0] < entryPrice;
  const distancesOk = longDistancesOk || shortDistancesOk;

  const sizeGate =
    roundedStop !== null ? riskSizeBaseQty({ entryPrice, stopLoss: roundedStop, quoteToHome, risk, rules }) : { qty: 0, reason: 'no_stop' as const };

  const volRatio =
    indicators.avgVolume20 && indicators.avgVolume20 > 0 ? indicators.volume / indicators.avgVolume20 : null;
  const volScore = volRatio === null ? 0.5 : clamp((volRatio - 0.8) / 0.8, 0, 1);
  const adxScore = adx === null ? 0 : clamp((adx - 18) / 22, 0, 1);
  const rsiScore =
    rsi === null
      ? 0
      : regime === 'TREND'
        ? clamp(1 - Math.abs(rsi - 57.5) / 12.5, 0, 1)
        : clamp((35 - rsi) / 15, 0, 1);

  const invalidationDistance = roundedStop !== null ? Math.abs(entryPrice - roundedStop) : 0;
  const invalidationScore =
    atr && atr > 0 ? clamp(1 - invalidationDistance / (2 * atr), 0, 1) : 0.25;

  const baseConfluence = mean([adxScore, rsiScore, volScore, invalidationScore]);
  const entryOk = distancesOk && (trendEntryOk || rangeEntryOk);
  const confidence = entryOk ? clamp(0.2 + 0.8 * baseConfluence, 0, 1) : clamp(0.15 + 0.35 * baseConfluence, 0, 0.5);

  const size = entryOk ? sizeGate.qty : 0;
  const feeEstimate = size * entryPrice * (risk.feeRate.taker * 2);

  const rr =
    roundedStop !== null && roundedTakeProfit[0] !== undefined
      ? Math.abs(roundedTakeProfit[0] - entryPrice) / Math.max(Math.abs(entryPrice - roundedStop), 0.00000001)
      : 0;

  return {
    horizon,
    thesis:
      regime === 'TREND'
        ? trendSide === 'BUY'
          ? 'Trend regime: bullish alignment. Buy pullbacks to EMA20 with ATR-based risk.'
          : 'Trend regime: bearish alignment. Spot long-only: avoid new longs / consider exiting.'
        : regime === 'RANGE'
          ? 'Range regime: mean-reversion entries near lower Bollinger band with ATR-based stops.'
          : 'Neutral regime: no clear edge; stay conservative.',
    entries: [
      {
        side,
        priceTarget: entryPrice,
        size,
        confidence,
      },
    ],
    exitPlan: {
      stopLoss: roundedStop ?? entryPrice,
      takeProfit: roundedTakeProfit,
      timeframeMinutes: pickTimeframe(horizon),
    },
    riskRewardRatio: rr,
    estimatedFees: Number.isFinite(feeEstimate) ? feeEstimate : 0,
    signalsUsed: [
      `Regime ${regime}`,
      `ADX14 ${adx !== null ? adx.toFixed(2) : 'n/a'}`,
      `EMA20/EMA50 ${ema20 !== null ? ema20.toFixed(6) : 'n/a'} / ${ema50 !== null ? ema50.toFixed(6) : 'n/a'}`,
      `RSI14 ${rsi !== null ? rsi.toFixed(2) : 'n/a'}`,
      `ATR14 ${atr !== null ? atr.toFixed(6) : 'n/a'}`,
      `BB20 ${bb.lower !== null ? bb.lower.toFixed(6) : 'n/a'}..${bb.upper !== null ? bb.upper.toFixed(6) : 'n/a'}`,
      `Vol ratio ${volRatio !== null ? volRatio.toFixed(2) : 'n/a'}`,
      `News sentiment ${(newsSentiment ?? 0).toFixed(2)}`,
      sizeGate.reason ? `Size gate: ${sizeGate.reason}` : 'Size gate: ok',
      trailingNote ? trailingNote : 'No trailing rule',
    ],
    aiNotes,
    createdAt: Date.now(),
  };
};

export const buildStrategyBundle = async (
  market: MarketSnapshot,
  risk: RiskSettings,
  newsSentiment: number,
  quoteToHome: number,
  options?: { useAi?: boolean; symbolRules?: SymbolRules },
): Promise<StrategyBundle> => {
  const useAi = options?.useAi ?? true;
  const [aiShort, aiMedium, aiLong] = useAi
    ? await Promise.all([
        generateAiInsight({ horizon: 'short', market, risk }),
        generateAiInsight({ horizon: 'medium', market, risk }),
        generateAiInsight({ horizon: 'long', market, risk }),
      ])
    : [
        { rationale: '', cautions: [], confidence: 0.0 },
        { rationale: '', cautions: [], confidence: 0.0 },
        { rationale: '', cautions: [], confidence: 0.0 },
      ];

  const fallbackIndicators = (interval: string): IndicatorSnapshot => ({
    symbol: market.symbol.toUpperCase(),
    interval,
    asOf: market.updatedAt ?? Date.now(),
    close: market.price,
    volume: market.volume,
    avgVolume20: null,
    ema20: null,
    ema50: null,
    rsi14: null,
    atr14: null,
    adx14: null,
    bb20: { middle: null, upper: null, lower: null, stdDev: null },
  });

  const safeFetch = async (interval: string): Promise<IndicatorSnapshot> => {
    try {
      return await fetchIndicatorSnapshot(market.symbol, interval, 200);
    } catch {
      return fallbackIndicators(interval);
    }
  };

  const [indShort, indMedium, indLong] = await Promise.all([
    safeFetch(intervalForHorizon('short')),
    safeFetch(intervalForHorizon('medium')),
    safeFetch(intervalForHorizon('long')),
  ]);

  // Optional: persist features for learning/analytics (best-effort; never blocks trading).
  persistMarketFeatures({
    at: indShort.asOf,
    symbol: indShort.symbol,
    interval: indShort.interval,
    close: indShort.close,
    volume: indShort.volume,
    avgVolume20: indShort.avgVolume20,
    ema20: indShort.ema20,
    ema50: indShort.ema50,
    rsi14: indShort.rsi14,
    atr14: indShort.atr14,
    adx14: indShort.adx14,
    bbMiddle: indShort.bb20.middle,
    bbUpper: indShort.bb20.upper,
    bbLower: indShort.bb20.lower,
  });
  persistMarketFeatures({
    at: indMedium.asOf,
    symbol: indMedium.symbol,
    interval: indMedium.interval,
    close: indMedium.close,
    volume: indMedium.volume,
    avgVolume20: indMedium.avgVolume20,
    ema20: indMedium.ema20,
    ema50: indMedium.ema50,
    rsi14: indMedium.rsi14,
    atr14: indMedium.atr14,
    adx14: indMedium.adx14,
    bbMiddle: indMedium.bb20.middle,
    bbUpper: indMedium.bb20.upper,
    bbLower: indMedium.bb20.lower,
  });
  persistMarketFeatures({
    at: indLong.asOf,
    symbol: indLong.symbol,
    interval: indLong.interval,
    close: indLong.close,
    volume: indLong.volume,
    avgVolume20: indLong.avgVolume20,
    ema20: indLong.ema20,
    ema50: indLong.ema50,
    rsi14: indLong.rsi14,
    atr14: indLong.atr14,
    adx14: indLong.adx14,
    bbMiddle: indLong.bb20.middle,
    bbUpper: indLong.bb20.upper,
    bbLower: indLong.bb20.lower,
  });

  return {
    short: buildRegimePlan('short', market, risk, indShort, aiShort.rationale, newsSentiment, quoteToHome, options?.symbolRules),
    medium: buildRegimePlan(
      'medium',
      market,
      risk,
      indMedium,
      aiMedium.rationale,
      newsSentiment,
      quoteToHome,
      options?.symbolRules,
    ),
    long: buildRegimePlan('long', market, risk, indLong, aiLong.rationale, newsSentiment, quoteToHome, options?.symbolRules),
  };
};
