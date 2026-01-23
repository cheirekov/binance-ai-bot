import { cancelOcoOrder, get24hStats, getBalances, placeOcoOrder, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getPersistedState, persistLastTrade, persistMeta, persistPosition } from './persistence.js';
import { getNewsSentiment } from './newsService.js';
import { getStrategyResponse, refreshStrategies } from './strategyService.js';
import { Balance, PersistedPayload } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';

const persisted = getPersistedState();

type SymbolInfo = Awaited<ReturnType<typeof fetchTradableSymbols>>[number];
type Position = PersistedPayload['positions'][string];

const stableLikeAssets = new Set([
  'USD',
  'EUR',
  'GBP',
  'USDT',
  'USDC',
  'BUSD',
  'TUSD',
  'FDUSD',
  'DAI',
  'USDP',
  'USDD',
]);

const isStableLikeAsset = (asset: string) => {
  const upper = asset.toUpperCase();
  if (stableLikeAssets.has(upper)) return true;
  if (upper.startsWith('USD') && upper.length <= 4) return true;
  return false;
};

const recordDecision = (decision: NonNullable<PersistedPayload['meta']>['lastAutoTrade']) => {
  persistMeta(persisted, { lastAutoTrade: decision });
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const accountBlacklistSet = () =>
  new Set(Object.keys(persisted.meta?.accountBlacklist ?? {}).map((s) => s.toUpperCase()));

const blacklistAccountSymbol = (symbol: string, reason: string) => {
  const upper = symbol.toUpperCase();
  const existing = persisted.meta?.accountBlacklist ?? {};
  if (existing[upper]) return;
  persistMeta(persisted, { accountBlacklist: { ...existing, [upper]: { at: Date.now(), reason } } });
};

const bumpConversionCounter = () => {
  const now = Date.now();
  const nextDate = todayKey();
  const current = persisted.meta?.conversions;
  const next =
    current && current.date === nextDate
      ? { date: nextDate, count: current.count + 1, lastAt: now }
      : { date: nextDate, count: 1, lastAt: now };
  persistMeta(persisted, { conversions: next });
};

const balanceMap = (balances: Balance[]) =>
  new Map(balances.map((b) => [b.asset.toUpperCase(), b.free]));

const numberFromUnknown = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const extractExecutedQty = (order: unknown): number | null => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  return (
    numberFromUnknown(rec.executedQty) ??
    numberFromUnknown(rec.origQty) ??
    numberFromUnknown(rec.quantity) ??
    null
  );
};

const findSymbolInfo = (symbols: SymbolInfo[], symbol: string) =>
  symbols.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());

const findConversion = (symbols: SymbolInfo[], fromAsset: string, toAsset: string) => {
  const from = fromAsset.toUpperCase();
  const to = toAsset.toUpperCase();
  const direct = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
  );
  if (direct) return { symbol: direct.symbol.toUpperCase(), side: 'BUY' as const };
  const inverse = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
  );
  if (inverse) return { symbol: inverse.symbol.toUpperCase(), side: 'SELL' as const };
  return null;
};

const getAssetToHomeRate = async (symbols: SymbolInfo[], asset: string, homeAsset: string): Promise<number | null> => {
  const assetUp = asset.toUpperCase();
  const homeUp = homeAsset.toUpperCase();
  if (assetUp === homeUp) return 1;
  const direct = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === assetUp && s.quoteAsset.toUpperCase() === homeUp,
  );
  if (direct) {
    const snap = await get24hStats(direct.symbol);
    return snap.price;
  }
  const inverse = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === homeUp && s.quoteAsset.toUpperCase() === assetUp,
  );
  if (inverse) {
    const snap = await get24hStats(inverse.symbol);
    return snap.price > 0 ? 1 / snap.price : null;
  }
  return null;
};

const ensureQuoteAsset = async (
  symbols: SymbolInfo[],
  balances: Balance[],
  homeAsset: string,
  quoteAsset: string,
  requiredQuote: number,
): Promise<{ balances: Balance[]; note?: string }> => {
  const home = homeAsset.toUpperCase();
  const quote = quoteAsset.toUpperCase();
  if (quote === home) return { balances };

  if (!config.conversionEnabled) {
    return { balances, note: `Conversions disabled; need ${quote}` };
  }

  const freeBy = balanceMap(balances);
  const freeQuote = freeBy.get(quote) ?? 0;
  if (freeQuote >= requiredQuote) return { balances };

  const conversion = findConversion(symbols, home, quote);
  if (!conversion) {
    return { balances, note: `No conversion path ${home}->${quote}` };
  }

  const missing = requiredQuote - freeQuote;
  if (missing <= 0) return { balances };

  const buffer = 1.001 + config.slippageBps / 10000;
  try {
    if (conversion.side === 'BUY') {
      const qty = missing * buffer;
      await placeOrder({ symbol: conversion.symbol, side: 'BUY', quantity: qty, type: 'MARKET' });
    } else {
      const snap = await get24hStats(conversion.symbol);
      const qtyFrom = snap.price > 0 ? (missing / snap.price) * buffer : 0;
      const freeHome = freeBy.get(home) ?? 0;
      if (qtyFrom <= 0 || freeHome <= 0) {
        return { balances, note: `Insufficient ${home} to convert` };
      }
      await placeOrder({ symbol: conversion.symbol, side: 'SELL', quantity: Math.min(qtyFrom, freeHome), type: 'MARKET' });
    }
    bumpConversionCounter();
    const refreshed = await refreshBalancesFromState();
    return { balances: refreshed, note: `Converted ${home}->${quote}` };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), conversion: `${home}->${quote}` }, 'Conversion to quote failed');
    return { balances, note: `Conversion failed: ${errorToString(error)}` };
  }
};

const convertToHome = async (
  symbols: SymbolInfo[],
  balances: Balance[],
  fromAsset: string,
  homeAsset: string,
  amountFrom: number,
): Promise<{ balances: Balance[]; note?: string }> => {
  const from = fromAsset.toUpperCase();
  const home = homeAsset.toUpperCase();
  if (from === home) return { balances };
  if (!config.conversionEnabled) return { balances, note: 'Conversions disabled' };

  const conversion = findConversion(symbols, from, home);
  if (!conversion) return { balances, note: `No conversion path ${from}->${home}` };

  const freeBy = balanceMap(balances);
  const freeFrom = freeBy.get(from) ?? 0;
  const qtyFrom = Math.min(amountFrom, freeFrom);
  if (qtyFrom <= 0) return { balances };

  const buffer = 1 - config.slippageBps / 10000;
  try {
    if (conversion.side === 'SELL') {
      await placeOrder({ symbol: conversion.symbol, side: 'SELL', quantity: qtyFrom * buffer, type: 'MARKET' });
    } else {
      const snap = await get24hStats(conversion.symbol);
      const qtyHome = snap.price > 0 ? qtyFrom * snap.price * buffer : 0;
      if (qtyHome <= 0) return { balances, note: 'Conversion sizing failed' };
      await placeOrder({ symbol: conversion.symbol, side: 'BUY', quantity: qtyHome, type: 'MARKET' });
    }
    bumpConversionCounter();
    const refreshed = await refreshBalancesFromState();
    return { balances: refreshed, note: `Converted ${from}->${home}` };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), conversion: `${from}->${home}` }, 'Conversion to home failed');
    return { balances, note: `Conversion failed: ${errorToString(error)}` };
  }
};

const refreshBalancesFromState = async (): Promise<Balance[]> => {
  // Prefer balances already fetched during strategy refresh; fallback to exchange if needed.
  const state = getStrategyResponse();
  if (state.balances?.length) return state.balances;
  const fallback = await refreshStrategies(state.symbol, { useAi: false }).then(() => getStrategyResponse(state.symbol));
  return fallback.balances ?? [];
};

const selectHorizon = (marketPrice: number, strategies: NonNullable<ReturnType<typeof getStrategyResponse>['strategies']>) => {
  const volPct =
    strategies.short && strategies.short.exitPlan
      ? Math.abs((strategies.short.exitPlan.stopLoss - marketPrice) / marketPrice) * 100
      : 0;
  const candidates: { h: 'short' | 'medium' | 'long'; score: number }[] = [];
  (['short', 'medium', 'long'] as const).forEach((h) => {
    const plan = strategies[h];
    if (!plan) return;
    const entry = plan.entries[0];
    let score = entry.confidence;
    score += plan.riskRewardRatio / 10;
    if (h === 'short' && volPct > 8) score += 0.1;
    if (h === 'medium' && volPct >= 4 && volPct <= 8) score += 0.05;
    if (h === 'long' && volPct < 4) score += 0.05;
    candidates.push({ h, score });
  });
  if (candidates.length === 0) return 'short' as const;
  if (config.autoTradeHorizon && strategies[config.autoTradeHorizon]) {
    const preferred = candidates.find((c) => c.h === config.autoTradeHorizon);
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a), candidates[0]);
    return best.score - (preferred?.score ?? 0) > 0.2 ? best.h : (config.autoTradeHorizon as 'short' | 'medium' | 'long');
  }
  return candidates.reduce((a, b) => (b.score > a.score ? b : a), candidates[0]).h;
};

const countOpenPositions = () =>
  Object.values(persisted.positions).filter((p) => p && p.side === 'BUY').length;

const allocatedHome = () =>
  Object.values(persisted.positions).reduce((sum, p) => sum + (p?.notionalHome ?? 0), 0);

const getPositionKey = (symbol: string, horizon: string) => `${symbol.toUpperCase()}:${horizon}`;

const closePosition = async (symbols: SymbolInfo[], positionKey: string, position: Position, balances: Balance[]) => {
  const symbol = position.symbol.toUpperCase();
  const info = findSymbolInfo(symbols, symbol);
  const baseAsset = (position.baseAsset ?? info?.baseAsset ?? '').toUpperCase();
  const quoteAsset = (position.quoteAsset ?? info?.quoteAsset ?? '').toUpperCase();
  const home = config.homeAsset.toUpperCase();

  const snap = await get24hStats(symbol);

  if (position.ocoOrderListId) {
    try {
      await cancelOcoOrder(symbol, position.ocoOrderListId);
  } catch (error) {
    logger.warn(
      { err: errorToLogObject(error), symbol, orderListId: position.ocoOrderListId },
      'Cancel OCO failed (may already be closed)',
    );
  }
  }

  const freeBy = balanceMap(balances);
  const freeBase = baseAsset ? (freeBy.get(baseAsset) ?? 0) : 0;
  if (freeBase <= 0) {
    persistPosition(persisted, positionKey, null);
    return { balances, note: `Position cleared (no ${baseAsset} balance)` };
  }

  const qtyToSell = Math.min(position.size, freeBase);
  try {
    await placeOrder({ symbol, side: 'SELL', quantity: qtyToSell, type: 'MARKET' });
    persistPosition(persisted, positionKey, null);
    const refreshed = await refreshBalancesFromState();
    if (quoteAsset && quoteAsset !== home) {
      const expectedQuote = qtyToSell * snap.price;
      const converted = await convertToHome(symbols, refreshed, quoteAsset, home, expectedQuote);
      return { balances: converted.balances, note: converted.note ?? 'Closed position' };
    }
    return { balances: refreshed, note: 'Closed position' };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), symbol }, 'Close position failed');
    return { balances, note: `Close failed: ${errorToString(error)}` };
  }
};

const reconcileOcoForPositions = async (symbols: SymbolInfo[]) => {
  if (!config.ocoEnabled) return;
  if (!config.tradingEnabled) return;

  const now = Date.now();
  const last = persisted.meta?.ocoReconcileAt ?? 0;
  if (now - last < 10 * 60 * 1000) return;

  const openWithoutOco = Object.entries(persisted.positions).filter(([, pos]) => {
    if (!pos) return false;
    if (pos.side !== 'BUY') return false;
    if (pos.ocoOrderListId) return false;
    if (!pos.stopLoss) return false;
    if (!pos.takeProfit?.length) return false;
    return true;
  });
  if (!openWithoutOco.length) return;

  let balances: Balance[] = [];
  try {
    balances = await getBalances();
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'OCO reconcile: failed to fetch balances');
    persistMeta(persisted, { ocoReconcileAt: now });
    return;
  }
  const freeBy = balanceMap(balances);

  for (const [key, pos] of openWithoutOco) {
    const symbol = pos.symbol.toUpperCase();
    const info = findSymbolInfo(symbols, symbol);
    const baseAsset = (pos.baseAsset ?? info?.baseAsset ?? '').toUpperCase();
    if (!baseAsset) continue;
    const freeBase = freeBy.get(baseAsset) ?? 0;
    if (freeBase <= 0) continue;
    const qty = Math.min(pos.size, freeBase);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    try {
      const oco = await placeOcoOrder({
        symbol,
        side: 'SELL',
        quantity: qty,
        takeProfit: pos.takeProfit![0]!,
        stopLoss: pos.stopLoss!,
      });
      if (oco && typeof (oco as { orderListId?: number }).orderListId === 'number') {
        const orderListId = (oco as { orderListId: number }).orderListId;
        persistPosition(persisted, key, { ...pos, size: qty, ocoOrderListId: orderListId });
        logger.info({ symbol, orderListId, quantity: qty }, 'OCO reconciled');
      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol }, 'OCO reconcile failed');
    }
  }

  persistMeta(persisted, { ocoReconcileAt: now });
};

const portfolioTick = async (seedSymbol?: string) => {
  const now = Date.now();
  const symbols = await fetchTradableSymbols();
  await reconcileOcoForPositions(symbols);
  const state = getStrategyResponse(seedSymbol);
  let balances: Balance[] = state.balances ?? [];
  if (!balances.length) balances = await refreshBalancesFromState();

  const home = config.homeAsset.toUpperCase();
  const freeBy = balanceMap(balances);
  const freeHome = freeBy.get(home) ?? 0;
  const maxAllocHome = (freeHome * config.portfolioMaxAllocPct) / 100;
  const blockedSymbols = accountBlacklistSet();

  // Global risk-off on negative sentiment (cached by news service).
  const news = await getNewsSentiment();
  const riskOff = news.sentiment <= config.riskOffSentiment;
  if (riskOff) {
    for (const [key, pos] of Object.entries(persisted.positions)) {
      if (!pos) continue;
      if (pos.side !== 'BUY') {
        persistPosition(persisted, key, null);
        continue;
      }
      const closed = await closePosition(symbols, key, pos, balances);
      balances = closed.balances;
    }
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: `Risk-off: news sentiment ${news.sentiment.toFixed(2)}` });
    return;
  }

  // Position exits (TP/SL)
  for (const [key, pos] of Object.entries(persisted.positions)) {
    if (!pos || pos.side !== 'BUY') continue;
    if (!pos.stopLoss && (!pos.takeProfit || pos.takeProfit.length === 0)) continue;
    const snap = await get24hStats(pos.symbol);
    if (pos.stopLoss !== undefined && snap.price <= pos.stopLoss) {
      const closed = await closePosition(symbols, key, pos, balances);
      balances = closed.balances;
      recordDecision({ at: now, symbol: pos.symbol, horizon: pos.horizon, action: 'placed', reason: closed.note ?? 'Stop triggered' });
      return;
    }
    if (pos.takeProfit?.length && snap.price >= pos.takeProfit[0]) {
      const closed = await closePosition(symbols, key, pos, balances);
      balances = closed.balances;
      recordDecision({ at: now, symbol: pos.symbol, horizon: pos.horizon, action: 'placed', reason: closed.note ?? 'Take-profit triggered' });
      return;
    }

    // Exit if current strategy flips to SELL or trading is halted for the symbol.
    try {
      await refreshStrategies(pos.symbol, { useAi: false });
      const latest = getStrategyResponse(pos.symbol);
      const latestPlan = latest.strategies?.[pos.horizon];
      if (latest.tradeHalted) {
        const closed = await closePosition(symbols, key, pos, balances);
        balances = closed.balances;
        recordDecision({ at: now, symbol: pos.symbol, horizon: pos.horizon, action: 'placed', reason: closed.note ?? 'Exit: risk flags' });
        return;
      }
      if (latestPlan && latestPlan.entries[0].side !== 'BUY') {
        const closed = await closePosition(symbols, key, pos, balances);
        balances = closed.balances;
        recordDecision({ at: now, symbol: pos.symbol, horizon: pos.horizon, action: 'placed', reason: closed.note ?? 'Exit: strategy flipped to SELL' });
        return;
      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol: pos.symbol }, 'Exit check refresh failed');
    }
  }

  const openCount = countOpenPositions();
  if (openCount >= config.portfolioMaxPositions) {
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: `Max positions reached (${config.portfolioMaxPositions})` });
    return;
  }

  const alreadyAllocated = allocatedHome();
  const remaining = Math.max(0, maxAllocHome - alreadyAllocated);
  if (remaining <= 0) {
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: `Allocation cap reached (${config.portfolioMaxAllocPct}%)` });
    return;
  }

  const ranked = persisted.meta?.rankedCandidates?.map((c) => c.symbol.toUpperCase()) ?? [];
  const universe = Array.from(new Set([state.symbol.toUpperCase(), ...ranked]))
    .filter((s) => !blockedSymbols.has(s.toUpperCase()))
    .slice(0, 20);

  for (const candidate of universe) {
    const hasOpen = Object.values(persisted.positions).some((p) => p?.side === 'BUY' && p.symbol.toUpperCase() === candidate);
    if (hasOpen) continue;

    // Refresh candidate quickly (heuristics-only) to get plans + risk flags.
    if (candidate !== state.symbol.toUpperCase()) {
      try {
        await refreshStrategies(candidate, { useAi: false });
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), candidate }, 'Candidate refresh failed');
        continue;
      }
    }

    const candidateState = getStrategyResponse(candidate);
    if (!candidateState.strategies || !candidateState.market) continue;
    if (candidateState.tradeHalted) continue;

    const horizon = selectHorizon(candidateState.market.price, candidateState.strategies);
    const plan = candidateState.strategies[horizon];
    const entry = plan.entries[0];
    if (entry.side !== 'BUY') continue; // spot bot does not open short positions

    if (entry.confidence < config.autoTradeMinConfidence) continue;

    const key = getPositionKey(candidate, horizon);
    const last = persisted.lastTrades[key] ?? 0;
    if (now - last < config.autoTradeCooldownMinutes * 60 * 1000) continue;

    const info = findSymbolInfo(symbols, candidate);
    const quoteAsset = (info?.quoteAsset ?? '').toUpperCase();
    const baseAsset = (info?.baseAsset ?? '').toUpperCase();
    if (!quoteAsset || !baseAsset) continue;
    if (isStableLikeAsset(baseAsset) && isStableLikeAsset(quoteAsset)) continue;

    const quoteToHome = await getAssetToHomeRate(symbols, quoteAsset, home);
    if (!quoteToHome) continue;

    const buffer = 1 + 0.002 + config.slippageBps / 10000;
    const price = candidateState.market.price;

    let quantity = entry.size;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const maxQtyByAlloc = remaining / (price * quoteToHome * buffer);
    quantity = Math.min(quantity, maxQtyByAlloc);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const requiredQuote = quantity * price * buffer;
    const ensured = await ensureQuoteAsset(symbols, balances, home, quoteAsset, requiredQuote);
    balances = ensured.balances;
    if (ensured.note && ensured.note.startsWith('Conversions disabled')) continue;
    if (ensured.note && ensured.note.startsWith('No conversion path')) continue;
    if (ensured.note && ensured.note.startsWith('Conversion failed')) continue;

    const freeNow = balanceMap(balances);
    const freeQuote = freeNow.get(quoteAsset) ?? 0;
    const maxAffordable = freeQuote > 0 ? freeQuote / (price * buffer) : 0;
    quantity = Math.min(quantity, maxAffordable);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      recordDecision({ at: now, symbol: candidate, horizon, action: 'skipped', reason: `Insufficient ${quoteAsset} for BUY` });
      return;
    }

    try {
      const order = await placeOrder({ symbol: candidate, side: 'BUY', quantity, type: 'MARKET' });
      persistLastTrade(persisted, key, now);

      const executedQty = extractExecutedQty(order) ?? quantity;
      let ocoQty = executedQty;

      if (config.ocoEnabled) {
        try {
          const freshBalances = await getBalances();
          if (freshBalances.length) balances = freshBalances;
          const freeAfter = balanceMap(balances);
          const freeBase = freeAfter.get(baseAsset) ?? 0;
          if (freeBase > 0) {
            ocoQty = Math.min(executedQty, freeBase);
          } else {
            ocoQty = executedQty * 0.998;
          }
        } catch (error) {
          logger.warn({ err: errorToLogObject(error), candidate }, 'Post-buy balance refresh failed; sizing OCO with buffer');
          ocoQty = executedQty * 0.998;
        }
      }

      const notionalHome = ocoQty * price * quoteToHome;
      const position: Position = {
        symbol: candidate,
        horizon,
        side: 'BUY',
        entryPrice: entry.priceTarget,
        size: ocoQty,
        stopLoss: plan.exitPlan.stopLoss,
        takeProfit: plan.exitPlan.takeProfit,
        baseAsset,
        quoteAsset,
        homeAsset: home,
        notionalHome,
        openedAt: now,
      };

      if (config.ocoEnabled) {
        try {
          const oco = await placeOcoOrder({
            symbol: candidate,
            side: 'SELL',
            quantity: ocoQty,
            takeProfit: plan.exitPlan.takeProfit[0],
            stopLoss: plan.exitPlan.stopLoss,
          });
          if (oco && typeof (oco as { orderListId?: number }).orderListId === 'number') {
            position.ocoOrderListId = (oco as { orderListId: number }).orderListId;
            logger.info({ symbol: candidate, orderListId: position.ocoOrderListId, quantity: position.size }, 'OCO placed');
          }
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), candidate }, 'OCO placement failed; position will rely on TP/SL checks');
      }
    }

      persistPosition(persisted, key, position);
      recordDecision({
        at: now,
        symbol: candidate,
        horizon,
        action: 'placed',
        orderId: (order as { orderId?: string | number } | undefined)?.orderId,
      });
      return;
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), candidate }, 'Portfolio entry failed');
      const message = errorToString(error);
      if (message.toLowerCase().includes('not permitted for this account')) {
        blacklistAccountSymbol(candidate, message);
      }
      recordDecision({
        at: now,
        symbol: candidate,
        horizon,
        action: 'error',
        reason: message,
      });
      return;
    }
  }

  recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: 'No eligible candidates to open' });
};

const singleSymbolTick = async (symbol?: string) => {
  const now = Date.now();
  const symbols = await fetchTradableSymbols();
  await reconcileOcoForPositions(symbols);
  const state = getStrategyResponse(symbol);
  if (!state.strategies || !state.market) {
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: 'No strategies yet' });
    return;
  }

  const horizon = selectHorizon(state.market.price, state.strategies);
  const plan = state.strategies[horizon];
  const entry = plan.entries[0];
  const positionKey = getPositionKey(state.symbol, horizon);

  const openPosition = persisted.positions[positionKey];
  if (openPosition && openPosition.side === 'BUY') {
    // Risk-off / exit checks for open long.
    const snap = await get24hStats(state.symbol);
    const stopLoss = openPosition.stopLoss ?? plan.exitPlan.stopLoss;
    const takeProfit = openPosition.takeProfit ?? plan.exitPlan.takeProfit;

    const news = await getNewsSentiment();
    if (news.sentiment <= config.riskOffSentiment) {
      let balances: Balance[] = state.balances ?? [];
      if (!balances.length) balances = await refreshBalancesFromState();
      const closed = await closePosition(symbols, positionKey, openPosition, balances);
      recordDecision({ at: now, symbol: state.symbol, horizon, action: 'placed', reason: closed.note ?? `Risk-off: sentiment ${news.sentiment.toFixed(2)}` });
      return;
    }

    if (stopLoss !== undefined && snap.price <= stopLoss) {
      let balances: Balance[] = state.balances ?? [];
      if (!balances.length) balances = await refreshBalancesFromState();
      const closed = await closePosition(symbols, positionKey, openPosition, balances);
      recordDecision({ at: now, symbol: state.symbol, horizon, action: 'placed', reason: closed.note ?? 'Stop triggered' });
      return;
    }
    if (takeProfit?.length && snap.price >= takeProfit[0]) {
      let balances: Balance[] = state.balances ?? [];
      if (!balances.length) balances = await refreshBalancesFromState();
      const closed = await closePosition(symbols, positionKey, openPosition, balances);
      recordDecision({ at: now, symbol: state.symbol, horizon, action: 'placed', reason: closed.note ?? 'Take-profit triggered' });
      return;
    }

    if (entry.side !== 'BUY') {
      let balances: Balance[] = state.balances ?? [];
      if (!balances.length) balances = await refreshBalancesFromState();
      const closed = await closePosition(symbols, positionKey, openPosition, balances);
      recordDecision({ at: now, symbol: state.symbol, horizon, action: 'placed', reason: closed.note ?? 'Exit: strategy flipped to SELL' });
      return;
    }

    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: 'Position already open' });
    return;
  }

  if (entry.side !== 'BUY') {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: 'SELL signal (spot bot opens longs only)' });
    return;
  }

  if (entry.confidence < config.autoTradeMinConfidence) {
    recordDecision({
      at: now,
      symbol: state.symbol,
      horizon,
      action: 'skipped',
      reason: `Low confidence ${(entry.confidence * 100).toFixed(0)}% < ${(config.autoTradeMinConfidence * 100).toFixed(0)}%`,
    });
    return;
  }

  const key = getPositionKey(state.symbol, horizon);
  const last = persisted.lastTrades[key] ?? 0;
  if (now - last < config.autoTradeCooldownMinutes * 60 * 1000) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: `Cooldown active (${config.autoTradeCooldownMinutes}m)` });
    return;
  }

  if (state.tradeHalted) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: `Risk flags: ${state.riskFlags.join('; ')}` });
    return;
  }

  let balances: Balance[] = state.balances ?? [];
  if (!balances.length) balances = await refreshBalancesFromState();

  const info = findSymbolInfo(symbols, state.symbol);
  const quoteAsset = (info?.quoteAsset ?? '').toUpperCase();
  const baseAsset = (info?.baseAsset ?? '').toUpperCase();
  if (!quoteAsset || !baseAsset) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: 'Symbol metadata missing' });
    return;
  }

  const home = config.homeAsset.toUpperCase();
  const quoteToHome = await getAssetToHomeRate(symbols, quoteAsset, home);
  if (!quoteToHome) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: `No conversion rate ${quoteAsset}->${home}` });
    return;
  }

  const price = state.market.price;
  let quantity = entry.size;
  const buffer = 1 + 0.002 + config.slippageBps / 10000;
  const requiredQuote = quantity * price * buffer;
  const ensured = await ensureQuoteAsset(symbols, balances, home, quoteAsset, requiredQuote);
  balances = ensured.balances;
  if (ensured.note && ensured.note.startsWith('Conversions disabled')) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: ensured.note });
    return;
  }

  const freeNow = balanceMap(balances);
  const freeQuote = freeNow.get(quoteAsset) ?? 0;
  const maxAffordable = freeQuote > 0 ? freeQuote / (price * buffer) : 0;
  quantity = Math.min(quantity, maxAffordable);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: `Insufficient ${quoteAsset} for BUY` });
    return;
  }

  try {
    const order = await placeOrder({ symbol: state.symbol, side: 'BUY', quantity, type: 'MARKET' });
    persistLastTrade(persisted, key, now);

    const executedQty = extractExecutedQty(order) ?? quantity;
    let ocoQty = executedQty;
    if (config.ocoEnabled) {
      try {
        const freshBalances = await getBalances();
        if (freshBalances.length) balances = freshBalances;
        const freeAfter = balanceMap(balances);
        const freeBase = freeAfter.get(baseAsset) ?? 0;
        if (freeBase > 0) {
          ocoQty = Math.min(executedQty, freeBase);
        } else {
          ocoQty = executedQty * 0.998;
        }
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), symbol: state.symbol }, 'Post-buy balance refresh failed; sizing OCO with buffer');
        ocoQty = executedQty * 0.998;
      }
    }

    const position: Position = {
      symbol: state.symbol,
      horizon,
      side: 'BUY',
      entryPrice: entry.priceTarget,
      size: ocoQty,
      stopLoss: plan.exitPlan.stopLoss,
      takeProfit: plan.exitPlan.takeProfit,
      baseAsset,
      quoteAsset,
      homeAsset: home,
      notionalHome: ocoQty * price * quoteToHome,
      openedAt: now,
    };

    if (config.ocoEnabled) {
      try {
        const oco = await placeOcoOrder({
          symbol: state.symbol,
          side: 'SELL',
          quantity: ocoQty,
          takeProfit: plan.exitPlan.takeProfit[0],
          stopLoss: plan.exitPlan.stopLoss,
        });
        if (oco && typeof (oco as { orderListId?: number }).orderListId === 'number') {
          position.ocoOrderListId = (oco as { orderListId: number }).orderListId;
          logger.info({ symbol: state.symbol, orderListId: position.ocoOrderListId, quantity: position.size }, 'OCO placed');
        }
      } catch (error) {
        logger.warn(
          { err: errorToLogObject(error), symbol: state.symbol },
          'OCO placement failed; position will rely on TP/SL checks',
        );
      }
    }

    persistPosition(persisted, key, position);
    recordDecision({
      at: now,
      symbol: state.symbol,
      horizon,
      action: 'placed',
      orderId: (order as { orderId?: string | number } | undefined)?.orderId,
    });
  } catch (error) {
    recordDecision({
      at: now,
      symbol: state.symbol,
      horizon,
      action: 'error',
      reason: errorToString(error),
    });
  }
};

export const autoTradeTick = async (symbol?: string) => {
  if (!config.autoTradeEnabled) return;
  if (persisted.meta?.emergencyStop) {
    recordDecision({ at: Date.now(), symbol: symbol ?? 'UNKNOWN', action: 'skipped', reason: 'Emergency stop enabled' });
    return;
  }
  if (!config.tradingEnabled) {
    logger.warn('Auto-trade enabled but TRADING_ENABLED=false; skipping');
    recordDecision({ at: Date.now(), symbol: symbol ?? 'UNKNOWN', action: 'skipped', reason: 'TRADING_ENABLED=false' });
    return;
  }

  try {
    if (config.portfolioEnabled) {
      await portfolioTick(symbol);
    } else {
      await singleSymbolTick(symbol);
    }
  } catch (error) {
    logger.error({ err: errorToLogObject(error), symbol: symbol ?? 'UNKNOWN' }, 'Auto-trade tick failed');
    recordDecision({
      at: Date.now(),
      symbol: symbol ?? 'UNKNOWN',
      action: 'error',
      reason: errorToString(error),
    });
  }
};
