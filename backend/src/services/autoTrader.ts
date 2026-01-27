import {
  cancelOcoOrder,
  get24hStats,
  getBalances,
  getFuturesEquity,
  getFuturesPositions,
  getOcoOrder,
  getOpenOcoOrders,
  placeOcoOrder,
  placeOrder,
} from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { applyRuntimeConfigOverrides, config } from '../config.js';
import { logger } from '../logger.js';
import { Balance, PersistedPayload } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { runAiPolicy } from './aiPolicy.js';
import { startOrSyncGrids } from './gridTrader.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistLastTrade, persistMeta, persistPosition } from './persistence.js';
import { getStrategyResponse, refreshStrategies } from './strategyService.js';
import { sweepUnusedToHome } from './sweepUnused.js';

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

const recordDecision = (decision: NonNullable<PersistedPayload['meta']>['lastAutoTrade']) => {
  persistMeta(persisted, { lastAutoTrade: decision });
};

type AutoTradeDecision = NonNullable<NonNullable<PersistedPayload['meta']>['lastAutoTrade']>;

const actionFromCloseNote = (note?: string): AutoTradeDecision['action'] => {
  if (!note) return 'placed';
  const lowered = note.toLowerCase();
  if (lowered.startsWith('close failed')) return 'error';
  if (lowered.startsWith('position cleared')) return 'skipped';
  return 'placed';
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const positionVenue = (pos: Position | null | undefined): 'spot' | 'futures' => (pos?.venue ?? 'spot');

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

const bumpAiSweepCounter = () => {
  const now = Date.now();
  const nextDate = todayKey();
  const current = persisted.meta?.aiSweeps;
  const next =
    current && current.date === nextDate
      ? { date: nextDate, count: current.count + 1, lastAt: now }
      : { date: nextDate, count: 1, lastAt: now };
  persistMeta(persisted, { aiSweeps: next });
};

const balanceMap = (balances: Balance[]) =>
  new Map(balances.map((b) => [b.asset.toUpperCase(), b.free]));

const balanceTotalsMap = (balances: Balance[]) =>
  new Map(balances.map((b) => [b.asset.toUpperCase(), { free: b.free, locked: b.locked, total: b.free + b.locked }]));

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

const getAssetToAssetRate = async (
  symbols: SymbolInfo[],
  fromAsset: string,
  toAsset: string,
): Promise<number | null> => {
  const from = fromAsset.toUpperCase();
  const to = toAsset.toUpperCase();
  if (from === to) return 1;

  const direct = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
  );
  if (direct) {
    const snap = await get24hStats(direct.symbol);
    return snap.price;
  }

  const inverse = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
  );
  if (inverse) {
    const snap = await get24hStats(inverse.symbol);
    return snap.price > 0 ? 1 / snap.price : null;
  }

  // Fallback to SPOT pricing for conversion pairs that may not exist on the selected venue (e.g. futures).
  try {
    const directSymbol = `${from}${to}`;
    const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(directSymbol)}`);
    if (res.ok) {
      const data = (await res.json()) as { price?: string };
      const price = data?.price ? Number(data.price) : Number.NaN;
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch {
    // ignore
  }
  try {
    const inverseSymbol = `${to}${from}`;
    const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(inverseSymbol)}`);
    if (res.ok) {
      const data = (await res.json()) as { price?: string };
      const price = data?.price ? Number(data.price) : Number.NaN;
      if (Number.isFinite(price) && price > 0) return 1 / price;
    }
  } catch {
    // ignore
  }

  return null;
};

const getAssetToHomeRate = async (symbols: SymbolInfo[], asset: string, homeAsset: string): Promise<number | null> => {
  const assetUp = asset.toUpperCase();
  const homeUp = homeAsset.toUpperCase();
  if (assetUp === homeUp) return 1;

  const direct = await getAssetToAssetRate(symbols, assetUp, homeUp);
  if (direct) return direct;

  // Try 2-hop pricing via common intermediates (needed for BTC-quoted alts like JSTBTC -> USDC).
  const intermediates = ['USDC', 'USDT', 'BTC', 'ETH', 'BNB'];
  for (const mid of intermediates) {
    const midUp = mid.toUpperCase();
    if (midUp === assetUp || midUp === homeUp) continue;
    const leg1 = await getAssetToAssetRate(symbols, assetUp, midUp);
    if (!leg1) continue;
    const leg2 = await getAssetToAssetRate(symbols, midUp, homeUp);
    if (!leg2) continue;
    return leg1 * leg2;
  }

  return null;
};

const computeEquityHome = async (
  symbols: SymbolInfo[],
  balances: Balance[],
  homeAsset: string,
): Promise<{ totalHome: number; missingAssets: string[] }> => {
  const home = homeAsset.toUpperCase();
  let totalHome = 0;
  const missingAssets: string[] = [];

  for (const bal of balances) {
    const asset = bal.asset.toUpperCase();
    const amount = (bal.free ?? 0) + (bal.locked ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    if (asset === home) {
      totalHome += amount;
      continue;
    }

    try {
      const rate = await getAssetToHomeRate(symbols, asset, home);
      if (!rate || !Number.isFinite(rate) || rate <= 0) {
        missingAssets.push(asset);
        continue;
      }
      totalHome += amount * rate;
    } catch {
      missingAssets.push(asset);
    }
  }

  return { totalHome, missingAssets };
};

const updateEquityTelemetry = async () => {
  if (!config.binanceApiKey || !config.binanceApiSecret) return;

  try {
    const now = Date.now();
    const prev = persisted.meta?.equity;
    if (prev && Number.isFinite(prev.lastAt) && now - prev.lastAt < Math.max(10_000, config.refreshSeconds * 1000)) {
      return;
    }

    let home = config.homeAsset.toUpperCase();

    let totalHome: number | null = null;
    let missingAssets: string[] = [];

    if (config.tradeVenue === 'futures') {
      const futuresEq = await getFuturesEquity();
      if (!futuresEq || !Number.isFinite(futuresEq.equity) || futuresEq.equity <= 0) return;
      home = futuresEq.asset.toUpperCase();
      totalHome = futuresEq.equity;
      missingAssets = [];
    } else {
      const symbols = await fetchTradableSymbols();
      const balances = await getBalances();
      if (!balances.length) return;
      const computed = await computeEquityHome(symbols, balances, home);
      totalHome = computed.totalHome;
      missingAssets = computed.missingAssets;
      if (!Number.isFinite(totalHome) || totalHome <= 0) return;
    }

    const prevMatches = !!prev && prev.homeAsset?.toUpperCase() === home;
    const sameDay =
      prevMatches && prev && Number.isFinite(prev.startAt)
        ? new Date(prev.startAt).toISOString().slice(0, 10) === todayKey()
        : false;
    const prevStartAt = prevMatches && sameDay && prev && Number.isFinite(prev.startAt) ? prev.startAt : null;
    const prevStartHome = prevMatches && sameDay && prev && Number.isFinite(prev.startHome) && prev.startHome > 0 ? prev.startHome : null;
    const scaleJump =
      prevStartHome !== null && Number.isFinite(totalHome) && totalHome > 0
        ? prevStartHome > totalHome * 50 || totalHome > prevStartHome * 50
        : false;
    if (scaleJump) {
      logger.warn(
        { prevStartHome, nextTotalHome: totalHome, homeAsset: home },
        'Equity baseline reset due to large scale jump (likely config/venue change)',
      );
    }
    const startAt = prevStartAt !== null && !scaleJump ? prevStartAt : now;
    const startHome = prevStartHome !== null && !scaleJump ? prevStartHome : totalHome;
    const pnlHome = totalHome - startHome;
    const pnlPct = startHome > 0 ? (pnlHome / startHome) * 100 : 0;

    persistMeta(persisted, {
      equity: {
        homeAsset: home,
        startAt,
        startHome,
        lastAt: now,
        lastHome: totalHome,
        pnlHome,
        pnlPct,
        missingAssets: missingAssets.length ? missingAssets : undefined,
      },
    });
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Equity telemetry update failed');
  }
};

const enforceDailyLossCap = async (seedSymbol?: string): Promise<boolean> => {
  if (!config.dailyLossCapPct || config.dailyLossCapPct <= 0) return false;

  await updateEquityTelemetry();
  const eq = persisted.meta?.equity;
  if (!eq || !Number.isFinite(eq.pnlPct)) return false;

  if (eq.pnlPct <= -Math.abs(config.dailyLossCapPct)) {
    const now = Date.now();
    const reason = `Daily loss cap hit: ${eq.pnlPct.toFixed(2)}% <= -${Math.abs(config.dailyLossCapPct).toFixed(2)}%`;
    persistMeta(persisted, {
      emergencyStop: true,
      emergencyStopAt: now,
      emergencyStopReason: reason,
    });
    recordDecision({ at: now, symbol: seedSymbol ?? persisted.meta?.activeSymbol ?? 'UNKNOWN', action: 'skipped', reason });
    logger.warn({ pnlPct: eq.pnlPct, capPct: config.dailyLossCapPct }, 'Daily loss cap triggered; emergency stop enabled');
    return true;
  }

  return false;
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
      const qtyHome = snap.price > 0 ? (qtyFrom / snap.price) * buffer : 0;
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

const isCountablePositionForVenue = (pos: Position) => {
  if (positionVenue(pos) !== config.tradeVenue) return false;
  // Spot bot is long-only; ignore stale SELL entries from older state files.
  if (config.tradeVenue === 'spot' && pos.side !== 'BUY') return false;
  return true;
};

const countOpenPositions = () => Object.values(persisted.positions).filter((p) => p && isCountablePositionForVenue(p)).length;

const allocatedHome = () =>
  Object.values(persisted.positions).reduce(
    (sum, p) => {
      if (!p || !isCountablePositionForVenue(p)) return sum;
      const notional = p.notionalHome ?? 0;
      if (!Number.isFinite(notional) || notional <= 0) return sum;
      if (config.tradeVenue !== 'futures') return sum + notional;
      const leverage = Math.max(1, p.leverage ?? config.futuresLeverage ?? 1);
      return sum + notional / leverage;
    },
    0,
  );

const getPositionKey = (symbol: string, horizon: string) => `${symbol.toUpperCase()}:${horizon}`;

const reconcilePositionsAgainstBalances = async (symbols: SymbolInfo[], balances: Balance[]) => {
  const totals = balanceTotalsMap(balances);

  for (const [key, pos] of Object.entries(persisted.positions)) {
    if (!pos) continue;
    if (positionVenue(pos) !== 'spot') continue;
    if (pos.side !== 'BUY') {
      persistPosition(persisted, key, null);
      logger.info({ symbol: pos.symbol, side: pos.side }, 'Spot position cleared (unsupported side)');
      continue;
    }
    const symbol = pos.symbol.toUpperCase();
    const info = findSymbolInfo(symbols, symbol);
    const baseAsset = (pos.baseAsset ?? info?.baseAsset ?? '').toUpperCase();
    if (!baseAsset) continue;

    const baseBal = totals.get(baseAsset) ?? { free: 0, locked: 0, total: 0 };
    const totalBase = baseBal.total;
    if (!Number.isFinite(totalBase) || totalBase <= 0) {
      persistPosition(persisted, key, null);
      logger.info({ symbol, baseAsset }, 'Position cleared (no balance found)');
      continue;
    }

    // Clamp to what's actually held and to the exchange step size.
    const rawQty = Math.min(pos.size, totalBase);
    const adjustedQty = floorToStep(rawQty, info?.stepSize);
    const minQty = info?.minQty ?? 0;
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0 || (minQty > 0 && adjustedQty < minQty)) {
      persistPosition(persisted, key, null);
      logger.info({ symbol, baseAsset, totalBase, minQty }, 'Position cleared (dust below minQty)');
      continue;
    }

    // If the position has become untradeable due to minNotional, treat it as dust and stop tracking.
    const minNotional = info?.minNotional ?? 0;
    if (minNotional > 0) {
      try {
        const snap = await get24hStats(symbol);
        const notional = adjustedQty * snap.price;
        if (notional < minNotional) {
          persistPosition(persisted, key, null);
          logger.info({ symbol, baseAsset, notional, minNotional }, 'Position cleared (below minNotional)');
          continue;
        }
      } catch {
        // If we can't price it right now, keep tracking and let exits handle it.
      }
    }

    // Update persisted size if it exceeds current holdings (partial fills/manual sells), to prevent repeated close failures.
    if (adjustedQty < pos.size) {
      const scale = pos.size > 0 ? adjustedQty / pos.size : 1;
      persistPosition(persisted, key, {
        ...pos,
        size: adjustedQty,
        notionalHome: pos.notionalHome !== undefined ? pos.notionalHome * scale : pos.notionalHome,
      });
      logger.info({ symbol, from: pos.size, to: adjustedQty }, 'Position size reconciled to current balance');
    }
  }
};

const reconcileFuturesPositionsAgainstAccount = async (symbols: SymbolInfo[]) => {
  const futuresPositions = await getFuturesPositions();
  const bySymbol = new Map(futuresPositions.map((p) => [p.symbol.toUpperCase(), p]));

  for (const [key, pos] of Object.entries(persisted.positions)) {
    if (!pos) continue;
    if (positionVenue(pos) !== 'futures') continue;

    const symbol = pos.symbol.toUpperCase();
    const live = bySymbol.get(symbol);
    if (!live) {
      persistPosition(persisted, key, null);
      logger.info({ symbol }, 'Futures position cleared (no open position on account)');
      continue;
    }

    const info = findSymbolInfo(symbols, symbol);
    const rawQty = Math.abs(live.positionAmt);
    const adjustedQty = floorToStep(rawQty, info?.stepSize);
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
      persistPosition(persisted, key, null);
      logger.info({ symbol, rawQty }, 'Futures position cleared (dust/zero)');
      continue;
    }

    const side = live.positionAmt >= 0 ? ('BUY' as const) : ('SELL' as const);
    let notionalHome = pos.notionalHome;
    try {
      const snap = await get24hStats(symbol);
      const quoteAsset = (pos.quoteAsset ?? info?.quoteAsset ?? '').toUpperCase();
      const quoteToHome = quoteAsset ? (await getAssetToHomeRate(symbols, quoteAsset, config.homeAsset)) ?? 1 : 1;
      notionalHome = adjustedQty * snap.price * quoteToHome;
    } catch {
      // keep previous notional if pricing fails
    }

    if (adjustedQty !== pos.size || side !== pos.side) {
      persistPosition(persisted, key, {
        ...pos,
        side,
        size: adjustedQty,
        venue: 'futures',
        leverage: pos.leverage ?? config.futuresLeverage,
        notionalHome,
      });
      logger.info({ symbol, from: `${pos.side}:${pos.size}`, to: `${side}:${adjustedQty}` }, 'Futures position reconciled');
    }
  }
};

const closePosition = async (symbols: SymbolInfo[], positionKey: string, position: Position, balances: Balance[]) => {
  const symbol = position.symbol.toUpperCase();
  const info = findSymbolInfo(symbols, symbol);
  const baseAsset = (position.baseAsset ?? info?.baseAsset ?? '').toUpperCase();
  const quoteAsset = (position.quoteAsset ?? info?.quoteAsset ?? '').toUpperCase();
  const home = config.homeAsset.toUpperCase();

  const snap = await get24hStats(symbol);

  if (positionVenue(position) === 'futures') {
    // Futures close: reduce-only market in the opposite direction.
    const live = (await getFuturesPositions()).find((p) => p.symbol.toUpperCase() === symbol);
    const amt = live?.positionAmt ?? 0;
    const rawQty = amt !== 0 ? Math.abs(amt) : position.size;
    const adjustedQty = floorToStep(rawQty, info?.stepSize);
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
      persistPosition(persisted, positionKey, null);
      return { balances, note: 'Position cleared (no futures size)' };
    }
    try {
      await placeOrder({
        symbol,
        side: position.side === 'BUY' ? 'SELL' : 'BUY',
        quantity: adjustedQty,
        type: 'MARKET',
        reduceOnly: true,
      });
      persistPosition(persisted, positionKey, null);
      const refreshed = await getBalances();
      return { balances: refreshed, note: 'Closed futures position' };
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol }, 'Close futures position failed');
      return { balances, note: `Close failed: ${errorToString(error)}` };
    }
  }

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

  const totals = balanceTotalsMap(balances);
  const baseBal = baseAsset ? totals.get(baseAsset) : undefined;
  const totalBase = baseBal?.total ?? 0;
  const freeBase = baseBal?.free ?? 0;

  if (!Number.isFinite(totalBase) || totalBase <= 0) {
    persistPosition(persisted, positionKey, null);
    return { balances, note: `Position cleared (no ${baseAsset} balance)` };
  }

  const qtyToSell = Math.min(position.size, freeBase > 0 ? freeBase : totalBase);
  const adjustedQty = floorToStep(qtyToSell, info?.stepSize);
  const minQty = info?.minQty ?? 0;
  if (!Number.isFinite(adjustedQty) || adjustedQty <= 0 || (minQty > 0 && adjustedQty < minQty)) {
    persistPosition(persisted, positionKey, null);
    return { balances, note: `Position cleared as dust (qty ${qtyToSell} < minQty ${minQty || 'unknown'})` };
  }

  const minNotional = info?.minNotional ?? 0;
  if (minNotional > 0 && adjustedQty * snap.price < minNotional) {
    persistPosition(persisted, positionKey, null);
    return { balances, note: `Position cleared as dust (notional ${(adjustedQty * snap.price).toFixed(8)} < minNotional ${minNotional})` };
  }
  try {
    await placeOrder({ symbol, side: 'SELL', quantity: adjustedQty, type: 'MARKET' });
    persistPosition(persisted, positionKey, null);
    const refreshed = await refreshBalancesFromState();
    if (quoteAsset && quoteAsset !== home) {
      const expectedQuote = adjustedQty * snap.price;
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
  if (config.tradeVenue !== 'spot') return;

  const now = Date.now();
  const last = persisted.meta?.ocoReconcileAt ?? 0;
  if (now - last < 10 * 60 * 1000) return;

  let balances: Balance[];
  try {
    balances = await getBalances();
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'OCO reconcile: failed to fetch balances');
    persistMeta(persisted, { ocoReconcileAt: now });
    return;
  }

  const totals = balanceTotalsMap(balances);

  let openOcos: unknown[] = [];
  let openOcosOk = true;
  try {
    openOcos = await getOpenOcoOrders();
  } catch (error) {
    openOcosOk = false;
    logger.warn({ err: errorToLogObject(error) }, 'OCO reconcile: failed to fetch open OCO orders');
    openOcos = [];
  }

  const byOrderListId = new Map<number, string>();
  const bySymbol = new Map<string, string>();
  for (const [key, pos] of Object.entries(persisted.positions)) {
    if (!pos) continue;
    if (positionVenue(pos) !== 'spot') continue;
    if (pos.symbol) bySymbol.set(pos.symbol.toUpperCase(), key);
    if (pos.ocoOrderListId) byOrderListId.set(pos.ocoOrderListId, key);
  }

  const allowedSymbolSet = new Set(config.allowedSymbols.map((s) => s.toUpperCase()));
  const allowedQuoteSet = new Set(config.allowedQuoteAssets.map((s) => s.toUpperCase()));
  const openOrderListIds = new Set<number>();

  for (const oco of openOcos) {
    if (!oco || typeof oco !== 'object') continue;
    const rec = oco as Record<string, unknown>;
    const orderListId = numberFromUnknown(rec.orderListId);
    const symbolRaw = rec.symbol;
    const symbol = typeof symbolRaw === 'string' ? symbolRaw.toUpperCase() : '';
    if (!orderListId || !symbol) continue;
    openOrderListIds.add(orderListId);

    if (byOrderListId.has(orderListId)) continue;

    const existingKey = bySymbol.get(symbol);
    if (existingKey) {
      const existing = persisted.positions[existingKey];
      if (existing && positionVenue(existing) === 'spot' && !existing.ocoOrderListId) {
        persistPosition(persisted, existingKey, { ...existing, ocoOrderListId: orderListId });
        logger.info({ symbol, orderListId }, 'OCO reconcile: linked open OCO to tracked position');
      }
      continue;
    }

    const info = findSymbolInfo(symbols, symbol);
    const quoteAsset = (info?.quoteAsset ?? '').toUpperCase();
    const baseAsset = (info?.baseAsset ?? '').toUpperCase();
    if (!quoteAsset || !baseAsset) continue;

    const isAllowed = config.allowedSymbols.length > 0 ? allowedSymbolSet.has(symbol) : allowedQuoteSet.has(quoteAsset);
    if (!isAllowed) continue;

    // Try to infer horizon from lastTrades; fallback to short.
    let horizon: Position['horizon'] = 'short';
    let bestTs = 0;
    for (const [key, ts] of Object.entries(persisted.lastTrades)) {
      const [sym, h] = key.split(':');
      if (sym?.toUpperCase() !== symbol) continue;
      if (!Number.isFinite(ts) || ts <= bestTs) continue;
      if (h === 'short' || h === 'medium' || h === 'long') {
        bestTs = ts;
        horizon = h;
      }
    }

    // Pull details (qty + prices) for a better import; if it fails, import as a minimal tracked position.
    let ocoQty = 0;
    let takeProfit: number[] | undefined;
    let stopLoss: number | undefined;
    let openedAt = now;
    try {
      const details = await getOcoOrder(orderListId);
      if (details && typeof details === 'object') {
        const det = details as Record<string, unknown>;
        const txTime = numberFromUnknown(det.transactionTime);
        if (txTime) openedAt = txTime;
        const reports = det.orderReports;
        if (Array.isArray(reports)) {
          let tp = 0;
          let sl = 0;
          let qty = 0;
          for (const report of reports) {
            if (!report || typeof report !== 'object') continue;
            const r = report as Record<string, unknown>;
            const side = String(r.side ?? '').toUpperCase();
            if (side !== 'SELL') continue;
            const type = String(r.type ?? '').toUpperCase();
            const qtyNum = numberFromUnknown(r.origQty) ?? numberFromUnknown(r.quantity) ?? 0;
            if (qtyNum > qty) qty = qtyNum;
            const price = numberFromUnknown(r.price) ?? 0;
            const stopPrice = numberFromUnknown(r.stopPrice) ?? 0;
            if (!tp && price > 0 && type.includes('LIMIT')) tp = price;
            if (!sl && stopPrice > 0 && type.includes('STOP')) sl = stopPrice;
          }
          ocoQty = qty;
          if (tp > 0) takeProfit = [tp];
          if (sl > 0) stopLoss = sl;
        }
      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol, orderListId }, 'OCO reconcile: failed to fetch OCO details');
    }

    const baseBal = totals.get(baseAsset) ?? { free: 0, locked: 0, total: 0 };
    const totalBase = baseBal.total;
    const qtySource = ocoQty > 0 ? ocoQty : totalBase;
    const size = floorToStep(Math.min(qtySource, totalBase > 0 ? totalBase : qtySource), info?.stepSize);
    if (!Number.isFinite(size) || size <= 0) continue;

    let entryPrice = 0;
    try {
      entryPrice = (await get24hStats(symbol)).price;
    } catch {
      // Keep entry price as 0 if pricing is temporarily unavailable.
    }

    let notionalHome: number | undefined;
    try {
      const quoteToHome = await getAssetToHomeRate(symbols, quoteAsset, config.homeAsset);
      if (quoteToHome && entryPrice > 0) {
        notionalHome = size * entryPrice * quoteToHome;
      }
    } catch {
      // ignore
    }

    const positionKey = getPositionKey(symbol, horizon);
    persistPosition(persisted, positionKey, {
      symbol,
      horizon,
      side: 'BUY',
      entryPrice: entryPrice > 0 ? entryPrice : 0,
      size,
      stopLoss,
      takeProfit,
      baseAsset,
      quoteAsset,
      homeAsset: config.homeAsset.toUpperCase(),
      notionalHome,
      ocoOrderListId: orderListId,
      venue: 'spot',
      openedAt,
    });
    logger.warn({ symbol, orderListId, size }, 'OCO reconcile: imported open OCO as a tracked position');
  }

  // If an OCO order list is no longer open on the exchange but we still hold the base asset,
  // clear the stale orderListId so the reconcile pass can re-arm exits.
  if (openOcosOk) {
    for (const [key, pos] of Object.entries(persisted.positions)) {
      if (!pos) continue;
      if (positionVenue(pos) !== 'spot') continue;
      if (pos.side !== 'BUY') continue;
      if (!pos.ocoOrderListId) continue;
      if (openOrderListIds.has(pos.ocoOrderListId)) continue;

      const symbol = pos.symbol.toUpperCase();
      const info = findSymbolInfo(symbols, symbol);
      const baseAsset = (pos.baseAsset ?? info?.baseAsset ?? '').toUpperCase();
      if (!baseAsset) continue;

      const baseBal = totals.get(baseAsset) ?? { free: 0, locked: 0, total: 0 };
      const totalBase = baseBal.total;
      if (!Number.isFinite(totalBase) || totalBase <= 0) {
        persistPosition(persisted, key, null);
        logger.warn({ symbol, orderListId: pos.ocoOrderListId }, 'OCO reconcile: cleared stale position (no balance)');
        continue;
      }

      persistPosition(persisted, key, { ...pos, ocoOrderListId: undefined });
      logger.warn({ symbol, orderListId: pos.ocoOrderListId }, 'OCO reconcile: OCO missing; will re-arm exits');
    }
  }

  const openWithoutOco = Object.entries(persisted.positions).filter(([, pos]) => {
    if (!pos) return false;
    if (positionVenue(pos) !== 'spot') return false;
    if (pos.side !== 'BUY') return false;
    if (pos.ocoOrderListId) return false;
    if (!pos.stopLoss) return false;
    if (!pos.takeProfit?.length) return false;
    return true;
  });

  if (openWithoutOco.length) {
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
  }

  persistMeta(persisted, { ocoReconcileAt: now });
};

const portfolioTick = async (
  seedSymbol?: string,
  options?: {
    entriesAllowed?: boolean;
    forceEntry?: { symbol: string; horizon: 'short' | 'medium' | 'long' };
  },
) => {
  const now = Date.now();
  const symbols = await fetchTradableSymbols();
  await reconcileOcoForPositions(symbols);
  const state = getStrategyResponse(seedSymbol);
  let balances: Balance[] = state.balances ?? [];
  if (!balances.length) balances = await refreshBalancesFromState();
  if (config.tradeVenue === 'futures') {
    await reconcileFuturesPositionsAgainstAccount(symbols);
  } else {
    await reconcilePositionsAgainstBalances(symbols, balances);
  }

  const home = config.homeAsset.toUpperCase();
  const freeBy = balanceMap(balances);
  let allocBaseHome = freeBy.get(home) ?? 0;
  if (config.tradeVenue === 'futures') {
    const cachedEq = persisted.meta?.equity;
    if (
      cachedEq &&
      cachedEq.homeAsset?.toUpperCase() === home &&
      Number.isFinite(cachedEq.lastHome) &&
      cachedEq.lastHome > 0
    ) {
      allocBaseHome = cachedEq.lastHome;
    }
    const futuresEq = await getFuturesEquity();
    if (futuresEq && futuresEq.asset.toUpperCase() === home && Number.isFinite(futuresEq.equity) && futuresEq.equity > 0) {
      // Use total margin balance (USDT-equivalent) as the allocation base, since futures collateral may not be held as HOME_ASSET.
      allocBaseHome = futuresEq.equity;
    }
  }
  const maxAllocHome = (allocBaseHome * config.portfolioMaxAllocPct) / 100;
  const blockedSymbols = accountBlacklistSet();
  if (config.gridEnabled) {
    for (const grid of Object.values(persisted.grids ?? {})) {
      if (grid?.status === 'running') blockedSymbols.add(grid.symbol.toUpperCase());
    }
  }

  // Global risk-off on negative sentiment (cached by news service).
  const news = await getNewsSentiment();
  const riskOff = news.sentiment <= config.riskOffSentiment;
  if (riskOff) {
    for (const [key, pos] of Object.entries(persisted.positions)) {
      if (!pos) continue;
      if (positionVenue(pos) !== config.tradeVenue) continue;
      const closed = await closePosition(symbols, key, pos, balances);
      balances = closed.balances;
    }
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: `Risk-off: news sentiment ${news.sentiment.toFixed(2)}` });
    return;
  }

  // Position exits (TP/SL)
  for (const [key, pos] of Object.entries(persisted.positions)) {
    if (!pos) continue;
    if (positionVenue(pos) !== config.tradeVenue) continue;
    if (!pos.stopLoss && (!pos.takeProfit || pos.takeProfit.length === 0)) continue;
    const snap = await get24hStats(pos.symbol);
      const isLong = pos.side === 'BUY';
	    if (pos.stopLoss !== undefined && (isLong ? snap.price <= pos.stopLoss : snap.price >= pos.stopLoss)) {
	      const closed = await closePosition(symbols, key, pos, balances);
	      balances = closed.balances;
	      recordDecision({
	        at: now,
	        symbol: pos.symbol,
	        horizon: pos.horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? 'Stop triggered',
	      });
	      return;
	    }
	    if (pos.takeProfit?.length && (isLong ? snap.price >= pos.takeProfit[0] : snap.price <= pos.takeProfit[0])) {
	      const closed = await closePosition(symbols, key, pos, balances);
	      balances = closed.balances;
	      recordDecision({
	        at: now,
	        symbol: pos.symbol,
	        horizon: pos.horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? 'Take-profit triggered',
	      });
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
	        recordDecision({
	          at: now,
	          symbol: pos.symbol,
	          horizon: pos.horizon,
	          action: actionFromCloseNote(closed.note),
	          reason: closed.note ?? 'Exit: risk flags',
	        });
	        return;
	      }
	      if (latestPlan && latestPlan.entries[0].side !== pos.side) {
	        const closed = await closePosition(symbols, key, pos, balances);
	        balances = closed.balances;
	        recordDecision({
	          at: now,
	          symbol: pos.symbol,
	          horizon: pos.horizon,
	          action: actionFromCloseNote(closed.note),
	          reason: closed.note ?? 'Exit: strategy flipped',
	        });
	        return;
	      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol: pos.symbol }, 'Exit check refresh failed');
    }
	  }

  const forceEntry = options?.forceEntry;
  const entriesAllowed = forceEntry ? true : (options?.entriesAllowed ?? true);
  if (!entriesAllowed) {
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: 'AI policy: HOLD (entries disabled)' });
    return;
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
  const universe = forceEntry
    ? [forceEntry.symbol.toUpperCase()].filter((s) => !blockedSymbols.has(s.toUpperCase()))
    : Array.from(new Set([state.symbol.toUpperCase(), ...ranked]))
        .filter((s) => !blockedSymbols.has(s.toUpperCase()))
        .slice(0, 20);

  for (const candidate of universe) {
    const hasOpen = Object.values(persisted.positions).some(
      (p) => p && positionVenue(p) === config.tradeVenue && p.symbol.toUpperCase() === candidate,
    );
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

    const horizon = forceEntry?.horizon ?? selectHorizon(candidateState.market.price, candidateState.strategies);
    const plan = candidateState.strategies[horizon];
    const entry = plan.entries[0];
    if (config.tradeVenue === 'spot' && entry.side !== 'BUY') continue; // spot bot does not open short positions

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

    const leverage = config.tradeVenue === 'futures' ? Math.max(1, config.futuresLeverage) : 1;
    const maxQtyByAlloc =
      config.tradeVenue === 'futures'
        ? (remaining * leverage) / (price * quoteToHome * buffer)
        : remaining / (price * quoteToHome * buffer);
    quantity = Math.min(quantity, maxQtyByAlloc);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const minNotional = info?.minNotional ?? 0;
    const preRoundedQty = floorToStep(quantity, info?.stepSize);
    if (minNotional > 0 && preRoundedQty * price < minNotional) {
      continue;
    }

    if (config.tradeVenue !== 'futures') {
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
        continue;
      }
    }

    const roundedQty = floorToStep(quantity, info?.stepSize);
    if (minNotional > 0 && roundedQty * price < minNotional) {
      recordDecision({
        at: now,
        symbol: candidate,
        horizon,
        action: 'skipped',
        reason: `Notional ${(roundedQty * price).toFixed(8)} below minNotional ${minNotional}`,
      });
      continue;
    }

    try {
      const order = await placeOrder({ symbol: candidate, side: entry.side, quantity: roundedQty, type: 'MARKET', price });
      persistLastTrade(persisted, key, now);

      const executedQty = extractExecutedQty(order) ?? roundedQty;
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
      let position: Position = {
        symbol: candidate,
        horizon,
        side: entry.side,
        entryPrice: entry.priceTarget,
        size: ocoQty,
        stopLoss: plan.exitPlan.stopLoss,
        takeProfit: plan.exitPlan.takeProfit,
        baseAsset,
        quoteAsset,
        homeAsset: home,
        notionalHome,
        venue: config.tradeVenue,
        leverage: config.tradeVenue === 'futures' ? config.futuresLeverage : undefined,
        openedAt: now,
      };

      // Persist immediately so we don't lose track of a successful entry even if OCO placement fails.
      persistPosition(persisted, key, position);

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
            const orderListId = (oco as { orderListId: number }).orderListId;
            position = { ...position, ocoOrderListId: orderListId };
            persistPosition(persisted, key, position);
            logger.info({ symbol: candidate, orderListId, quantity: position.size }, 'OCO placed');
          }
        } catch (error) {
          logger.warn({ err: errorToLogObject(error), candidate }, 'OCO placement failed; position will rely on TP/SL checks');
        }
      }

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
      const lowered = message.toLowerCase();
      if (lowered.includes('not permitted for this account')) {
        blacklistAccountSymbol(candidate, message);
      }
      recordDecision({
        at: now,
        symbol: candidate,
        horizon,
        action: 'error',
        reason: message,
      });
      if (
        lowered.includes('below minnotional') ||
        lowered.includes('below minqty') ||
        lowered.includes('insufficient') ||
        lowered.includes('not permitted for this account')
      ) {
        continue;
      }
      return;
    }
  }

  recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: 'No eligible candidates to open' });
};

const singleSymbolTick = async (
  symbol?: string,
  options?: { entriesAllowed?: boolean; horizonOverride?: 'short' | 'medium' | 'long' },
) => {
  const now = Date.now();
  const symbols = await fetchTradableSymbols();
  await reconcileOcoForPositions(symbols);
  const state = getStrategyResponse(symbol);
  if (!state.strategies || !state.market) {
    recordDecision({ at: now, symbol: state.symbol, action: 'skipped', reason: 'No strategies yet' });
    return;
  }

  const horizon = options?.horizonOverride ?? selectHorizon(state.market.price, state.strategies);
  const plan = state.strategies[horizon];
  const entry = plan.entries[0];
  const positionKey = getPositionKey(state.symbol, horizon);

  let balances: Balance[] = state.balances ?? [];
  if (!balances.length) balances = await refreshBalancesFromState();
  if (config.tradeVenue === 'futures') {
    await reconcileFuturesPositionsAgainstAccount(symbols);
  } else {
    await reconcilePositionsAgainstBalances(symbols, balances);
  }

  const openPosition = persisted.positions[positionKey];
  if (openPosition && positionVenue(openPosition) === config.tradeVenue) {
    // Risk-off / exit checks for open position.
    const snap = await get24hStats(state.symbol);
    const stopLoss = openPosition.stopLoss ?? plan.exitPlan.stopLoss;
    const takeProfit = openPosition.takeProfit ?? plan.exitPlan.takeProfit;
    const isLong = openPosition.side === 'BUY';

	    const news = await getNewsSentiment();
	    if (news.sentiment <= config.riskOffSentiment) {
	      const closed = await closePosition(symbols, positionKey, openPosition, balances);
	      recordDecision({
	        at: now,
	        symbol: state.symbol,
	        horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? `Risk-off: sentiment ${news.sentiment.toFixed(2)}`,
	      });
	      return;
	    }

	    if (stopLoss !== undefined && (isLong ? snap.price <= stopLoss : snap.price >= stopLoss)) {
	      const closed = await closePosition(symbols, positionKey, openPosition, balances);
	      recordDecision({
	        at: now,
	        symbol: state.symbol,
	        horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? 'Stop triggered',
	      });
	      return;
	    }
	    if (takeProfit?.length && (isLong ? snap.price >= takeProfit[0] : snap.price <= takeProfit[0])) {
	      const closed = await closePosition(symbols, positionKey, openPosition, balances);
	      recordDecision({
	        at: now,
	        symbol: state.symbol,
	        horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? 'Take-profit triggered',
	      });
	      return;
	    }

	    if (entry.side !== openPosition.side) {
	      const closed = await closePosition(symbols, positionKey, openPosition, balances);
	      recordDecision({
	        at: now,
	        symbol: state.symbol,
	        horizon,
	        action: actionFromCloseNote(closed.note),
	        reason: closed.note ?? 'Exit: strategy flipped',
	      });
	      return;
	    }

    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: 'Position already open' });
    return;
  }

  if (config.tradeVenue === 'spot' && entry.side !== 'BUY') {
    recordDecision({
      at: now,
      symbol: state.symbol,
      horizon,
      action: 'skipped',
      reason: 'SELL signal (spot bot opens longs only)',
    });
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

  if (options?.entriesAllowed === false) {
    recordDecision({ at: now, symbol: state.symbol, horizon, action: 'skipped', reason: 'AI policy: HOLD (entries disabled)' });
    return;
  }

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
  if (config.tradeVenue !== 'futures') {
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
      recordDecision({
        at: now,
        symbol: state.symbol,
        horizon,
        action: 'skipped',
        reason: `Insufficient ${quoteAsset} to trade`,
      });
      return;
    }
  }

  try {
    const adjustedQty = floorToStep(quantity, info?.stepSize);
    const minQty = info?.minQty ?? 0;
    const minNotional = info?.minNotional ?? 0;
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0 || (minQty > 0 && adjustedQty < minQty)) {
      recordDecision({
        at: now,
        symbol: state.symbol,
        horizon,
        action: 'skipped',
        reason: `Quantity ${adjustedQty} below minQty ${minQty || 'unknown'}`,
      });
      return;
    }
    if (minNotional > 0 && adjustedQty * price < minNotional) {
      recordDecision({
        at: now,
        symbol: state.symbol,
        horizon,
        action: 'skipped',
        reason: `Notional ${(adjustedQty * price).toFixed(8)} below minNotional ${minNotional}`,
      });
      return;
    }

    const order = await placeOrder({ symbol: state.symbol, side: entry.side, quantity: adjustedQty, type: 'MARKET', price });
    persistLastTrade(persisted, key, now);

    const executedQty = extractExecutedQty(order) ?? adjustedQty;
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

    let position: Position = {
      symbol: state.symbol,
      horizon,
      side: entry.side,
      entryPrice: entry.priceTarget,
      size: ocoQty,
      stopLoss: plan.exitPlan.stopLoss,
      takeProfit: plan.exitPlan.takeProfit,
      baseAsset,
      quoteAsset,
      homeAsset: home,
      notionalHome: ocoQty * price * quoteToHome,
      venue: config.tradeVenue,
      leverage: config.tradeVenue === 'futures' ? config.futuresLeverage : undefined,
      openedAt: now,
    };

    // Persist immediately so we don't lose track of a successful entry even if OCO placement fails.
    persistPosition(persisted, key, position);

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
          const orderListId = (oco as { orderListId: number }).orderListId;
          position = { ...position, ocoOrderListId: orderListId };
          persistPosition(persisted, key, position);
          logger.info({ symbol: state.symbol, orderListId, quantity: position.size }, 'OCO placed');
        }
      } catch (error) {
        logger.warn(
          { err: errorToLogObject(error), symbol: state.symbol },
          'OCO placement failed; position will rely on TP/SL checks',
        );
      }
    }

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
    await updateEquityTelemetry();
    return;
  }

  if (await enforceDailyLossCap(symbol)) {
    // emergencyStop is now enabled; do nothing else this tick.
    await updateEquityTelemetry();
    return;
  }

  if (config.aiPolicyMode === 'advisory') {
    const aiDecision = await runAiPolicy(symbol);
    recordDecision({
      at: aiDecision?.at ?? Date.now(),
      symbol: aiDecision?.symbol ?? symbol ?? 'UNKNOWN',
      horizon: aiDecision?.horizon,
      action: 'skipped',
      reason: aiDecision
        ? `AI policy advisory: ${aiDecision.action}${aiDecision.reason ? ` · ${aiDecision.reason}` : ''}`.slice(0, 200)
        : 'AI policy advisory: rate-limited',
    });
    await updateEquityTelemetry();
    return;
  }

  if (!config.tradingEnabled) {
    logger.warn('Auto-trade enabled but TRADING_ENABLED=false; skipping');
    recordDecision({ at: Date.now(), symbol: symbol ?? 'UNKNOWN', action: 'skipped', reason: 'TRADING_ENABLED=false' });
    await updateEquityTelemetry();
    return;
  }
  if (config.tradeVenue === 'futures' && !config.futuresEnabled) {
    logger.warn('Auto-trade enabled but FUTURES_ENABLED=false; skipping');
    recordDecision({ at: Date.now(), symbol: symbol ?? 'UNKNOWN', action: 'skipped', reason: 'FUTURES_ENABLED=false' });
    await updateEquityTelemetry();
    return;
  }

  const aiDecision = await runAiPolicy(symbol);
  if (config.aiPolicyMode === 'gated-live' && !aiDecision) {
    // If AI policy is enabled but rate-limited/unavailable, hold (manage exits, no new entries).
    if (config.gridEnabled) {
      await startOrSyncGrids();
    }
    if (!config.portfolioEnabled && config.gridEnabled) {
      await updateEquityTelemetry();
      return;
    }
    if (config.portfolioEnabled) {
      await portfolioTick(symbol, { entriesAllowed: false });
    } else {
      await singleSymbolTick(symbol, { entriesAllowed: false });
    }
    await updateEquityTelemetry();
    return;
  }

  try {
    if (config.aiPolicyMode === 'gated-live' && aiDecision) {
      if (config.aiPolicyTuningAutoApply && aiDecision.tune && Object.keys(aiDecision.tune).length > 0) {
        const alreadyAppliedAt = persisted.meta?.runtimeConfig?.updatedAt ?? 0;
        if (alreadyAppliedAt < aiDecision.at) {
          const applied = applyRuntimeConfigOverrides({ ...aiDecision.tune }, { mutate: true });
          if (Object.keys(applied).length > 0) {
            persistMeta(persisted, {
              runtimeConfig: {
                updatedAt: Date.now(),
                source: 'ai',
                reason: `ai-policy:${aiDecision.action}`,
                values: applied,
              },
            });
            logger.info({ applied }, 'AI policy applied runtime tuning');
          }
        }
      }

      if (config.aiPolicySweepAutoApply && aiDecision.sweepUnusedToHome && config.tradeVenue === 'spot') {
        const now = Date.now();
        const cooldownMs = Math.max(0, config.aiPolicySweepCooldownMinutes) * 60_000;
        const lastSweepAt = persisted.meta?.aiSweeps?.lastAt ?? 0;
        if (!lastSweepAt || now - lastSweepAt >= cooldownMs) {
          const res = await sweepUnusedToHome({
            dryRun: false,
            keepAllowedQuotes: true,
            keepPositionAssets: true,
            keepAssets: [],
          });
          if (res.ok) {
            bumpAiSweepCounter();
            logger.info({ summary: res.summary, stillHeld: res.summary.stillHeld }, 'AI policy sweep-unused executed');
          } else {
            logger.warn({ error: res.error }, 'AI policy sweep-unused failed');
          }
        }
      }

      if (aiDecision.action === 'PANIC') {
        persistMeta(persisted, { emergencyStop: true, emergencyStopAt: Date.now(), emergencyStopReason: 'ai-policy' });
        recordDecision({
          at: aiDecision.at,
          symbol: aiDecision.symbol ?? symbol ?? 'UNKNOWN',
          action: 'skipped',
          reason: `AI policy PANIC: ${aiDecision.reason}`.slice(0, 200),
        });
        await updateEquityTelemetry();
        return;
      }

      if (aiDecision.action === 'CLOSE' && aiDecision.positionKey) {
        const pos = persisted.positions[aiDecision.positionKey];
        if (!pos || positionVenue(pos) !== config.tradeVenue) {
          recordDecision({
            at: aiDecision.at,
            symbol: aiDecision.symbol ?? symbol ?? 'UNKNOWN',
            action: 'skipped',
            reason: `AI policy CLOSE ignored: unknown positionKey ${aiDecision.positionKey}`.slice(0, 200),
          });
          await updateEquityTelemetry();
          return;
        }

        const symbols = await fetchTradableSymbols();
        let balances: Balance[] = [];
        try {
          balances = await refreshBalancesFromState();
        } catch {
          balances = [];
        }
        const closed = await closePosition(symbols, aiDecision.positionKey, pos, balances);
        recordDecision({
          at: aiDecision.at,
          symbol: pos.symbol,
          horizon: pos.horizon,
          action: actionFromCloseNote(closed.note),
          reason: closed.note ?? `AI policy CLOSE: ${aiDecision.reason}`.slice(0, 200),
        });
        await updateEquityTelemetry();
        return;
      }

      if (aiDecision.action === 'OPEN' && aiDecision.symbol && aiDecision.horizon) {
        if (config.gridEnabled) {
          await startOrSyncGrids();
        }
        if (!config.portfolioEnabled && config.gridEnabled) {
          recordDecision({
            at: aiDecision.at,
            symbol: aiDecision.symbol,
            horizon: aiDecision.horizon,
            action: 'skipped',
            reason: 'AI policy OPEN ignored: grid-only mode (enable PORTFOLIO_ENABLED for mixed trading)',
          });
          await updateEquityTelemetry();
          return;
        }
        if (config.portfolioEnabled) {
          await portfolioTick(aiDecision.symbol, { forceEntry: { symbol: aiDecision.symbol, horizon: aiDecision.horizon } });
        } else {
          await singleSymbolTick(aiDecision.symbol, { horizonOverride: aiDecision.horizon });
        }
        await updateEquityTelemetry();
        return;
      }

      if (aiDecision.action === 'HOLD') {
        if (config.gridEnabled) {
          await startOrSyncGrids();
        }
        if (!config.portfolioEnabled && config.gridEnabled) {
          await updateEquityTelemetry();
          return;
        }
        if (config.portfolioEnabled) {
          await portfolioTick(symbol, { entriesAllowed: false });
        } else {
          await singleSymbolTick(symbol, { entriesAllowed: false });
        }
        await updateEquityTelemetry();
        return;
      }
    }

    if (config.gridEnabled) {
      await startOrSyncGrids();
    }
    if (!config.portfolioEnabled && config.gridEnabled) {
      await updateEquityTelemetry();
      return;
    }
    if (config.portfolioEnabled) {
      await portfolioTick(symbol);
    } else {
      await singleSymbolTick(symbol);
    }
    await updateEquityTelemetry();
  } catch (error) {
    logger.error({ err: errorToLogObject(error), symbol: symbol ?? 'UNKNOWN' }, 'Auto-trade tick failed');
    recordDecision({
      at: Date.now(),
      symbol: symbol ?? 'UNKNOWN',
      action: 'error',
      reason: errorToString(error),
    });
    await updateEquityTelemetry();
  }
};
