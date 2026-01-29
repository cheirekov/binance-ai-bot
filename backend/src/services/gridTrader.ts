import { cancelOrder, get24hStats, getBalances, getKlines, getOpenOrders, getOrder, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { Balance, GridOrder, GridState } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getPersistedState, persistGrid, persistMeta } from './persistence.js';
import { persistGridFill } from './sqlite.js';

const persisted = getPersistedState();

type SymbolInfo = Awaited<ReturnType<typeof fetchTradableSymbols>>[number];

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

const looksLeverageToken = (symbol: string) => /(UP|DOWN|BULL|BEAR)$/.test(symbol.toUpperCase());

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

const floorToTick = (value: number, tick?: number) => {
  if (!tick) return value;
  const decimals = decimalsForStep(tick);
  const floored = Math.floor(value / tick) * tick;
  return Number(floored.toFixed(decimals));
};

const balanceFreeMap = (balances: Balance[]) => new Map(balances.map((b) => [b.asset.toUpperCase(), b.free ?? 0]));

const clampNonNegative = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);

const ensurePerformance = (grid: GridState, now: number): NonNullable<GridState['performance']> => {
  const existing = grid.performance;
  const allocation = clampNonNegative(grid.allocationHome ?? 0);
  if (existing && Number.isFinite(existing.startAt) && Number.isFinite(existing.startValueHome)) {
    return {
      ...existing,
      startAt: existing.startAt || grid.createdAt || now,
      startValueHome: Number.isFinite(existing.startValueHome) ? existing.startValueHome : allocation,
      lastAt: Number.isFinite(existing.lastAt) ? existing.lastAt : now,
      lastValueHome: Number.isFinite(existing.lastValueHome) ? existing.lastValueHome : allocation,
      pnlHome: Number.isFinite(existing.pnlHome) ? existing.pnlHome : 0,
      pnlPct: Number.isFinite(existing.pnlPct) ? existing.pnlPct : 0,
      baseVirtual: clampNonNegative(existing.baseVirtual),
      quoteVirtual: clampNonNegative(existing.quoteVirtual),
      feesHome: clampNonNegative(existing.feesHome),
      fillsBuy: Math.max(0, Math.floor(existing.fillsBuy ?? 0)),
      fillsSell: Math.max(0, Math.floor(existing.fillsSell ?? 0)),
      breakouts: Math.max(0, Math.floor(existing.breakouts ?? 0)),
      lastFillAt: existing.lastFillAt,
    };
  }
  return {
    startAt: grid.createdAt || now,
    startValueHome: allocation,
    lastAt: now,
    lastValueHome: allocation,
    pnlHome: 0,
    pnlPct: 0,
    baseVirtual: 0,
    quoteVirtual: allocation,
    feesHome: 0,
    fillsBuy: 0,
    fillsSell: 0,
    breakouts: 0,
    lastFillAt: undefined,
  };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const applyFillToPerformance = (
  perf: NonNullable<GridState['performance']>,
  order: unknown,
  now: number,
) => {
  if (!order || typeof order !== 'object') return perf;
  const rec = order as Record<string, unknown>;
  const status = String(rec.status ?? '').toUpperCase();
  const side = String(rec.side ?? '').toUpperCase();
  const type = String(rec.type ?? '').toUpperCase();
  if (!status) return perf;

  const executedQty = toNumber(rec.executedQty ?? rec.executedQuantity ?? rec.origQty) ?? 0;
  if (!Number.isFinite(executedQty) || executedQty <= 0) return perf;

  const quoteQty =
    toNumber(rec.cummulativeQuoteQty ?? rec.cumulativeQuoteQty ?? rec.cumQuote ?? rec.cumQuoteQty) ??
    0;
  const price = toNumber(rec.price) ?? 0;
  const notional = quoteQty > 0 ? quoteQty : executedQty * Math.max(price, 0.00000001);
  if (!Number.isFinite(notional) || notional <= 0) return perf;

  const feeEst = notional * (type === 'MARKET' ? feeRate.taker : feeRate.maker);

  const next: NonNullable<GridState['performance']> = { ...perf };
  if (side === 'BUY') {
    next.baseVirtual = next.baseVirtual + executedQty;
    next.quoteVirtual = Math.max(0, next.quoteVirtual - notional);
    next.fillsBuy = (next.fillsBuy ?? 0) + (status === 'FILLED' || status === 'PARTIALLY_FILLED' ? 1 : 0);
  } else if (side === 'SELL') {
    next.baseVirtual = Math.max(0, next.baseVirtual - executedQty);
    next.quoteVirtual = next.quoteVirtual + notional;
    next.fillsSell = (next.fillsSell ?? 0) + (status === 'FILLED' || status === 'PARTIALLY_FILLED' ? 1 : 0);
  }
  next.feesHome = clampNonNegative(next.feesHome + feeEst);
  next.lastFillAt = now;
  return next;
};

const extractGridFillRow = (symbol: string, order: unknown, now: number) => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  const status = String(rec.status ?? '').toUpperCase();
  const side = String(rec.side ?? '').toUpperCase();
  const type = String(rec.type ?? '').toUpperCase();
  if (status !== 'FILLED' && status !== 'PARTIALLY_FILLED') return null;
  if (side !== 'BUY' && side !== 'SELL') return null;

  const executedQty = toNumber(rec.executedQty ?? rec.executedQuantity ?? rec.origQty) ?? 0;
  if (!Number.isFinite(executedQty) || executedQty <= 0) return null;

  const quoteQty = toNumber(rec.cummulativeQuoteQty ?? rec.cumulativeQuoteQty ?? rec.cumQuote ?? rec.cumQuoteQty) ?? 0;
  const price = toNumber(rec.price) ?? null;
  const notional = quoteQty > 0 ? quoteQty : executedQty * Math.max(price ?? 0, 0.00000001);
  if (!Number.isFinite(notional) || notional <= 0) return null;

  const feeEst = notional * (type === 'MARKET' ? feeRate.taker : feeRate.maker);
  const orderId = rec.orderId !== undefined ? String(rec.orderId) : undefined;
  const normalizedPrice = price && price > 0 ? price : notional / executedQty;

  return {
    at: now,
    symbol: symbol.toUpperCase(),
    side,
    executedQty,
    notional,
    feeEst,
    price: normalizedPrice,
    orderId,
  };
};

const revaluePerformance = (perf: NonNullable<GridState['performance']>, now: number, price: number) => {
  const baseValue = clampNonNegative(perf.baseVirtual) * Math.max(price, 0);
  const gross = baseValue + clampNonNegative(perf.quoteVirtual);
  const net = Math.max(0, gross - clampNonNegative(perf.feesHome));
  const start = Math.max(0, perf.startValueHome);
  const pnl = net - start;
  const pnlPct = start > 0 ? (pnl / start) * 100 : 0;
  return {
    ...perf,
    lastAt: now,
    lastValueHome: net,
    pnlHome: pnl,
    pnlPct,
  };
};

const percentile = (values: number[], p: number) => {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const pct = Math.min(1, Math.max(0, p));
  const idx = pct * (clean.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return clean[lo] ?? null;
  const w = idx - lo;
  return (clean[lo] ?? 0) * (1 - w) + (clean[hi] ?? 0) * w;
};

const geometricGrid = (lower: number, upper: number, levels: number) => {
  if (levels < 2) return [lower, upper];
  const ratio = Math.pow(upper / lower, 1 / (levels - 1));
  const prices: number[] = [];
  for (let i = 0; i < levels; i += 1) {
    prices.push(lower * Math.pow(ratio, i));
  }
  return prices;
};

const findSymbolInfo = (symbols: SymbolInfo[], symbol: string) =>
  symbols.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());

const isSpotTradable = (s: SymbolInfo) =>
  s.status === 'TRADING' && ((s.permissions?.includes('SPOT') ?? false) || s.isSpotTradingAllowed);

const inGap = (levelPrice: number, currentPrice: number) => {
  const gapPct = config.gridGapBps / 10_000;
  return Math.abs(levelPrice - currentPrice) / Math.max(currentPrice, 0.00000001) < gapPct;
};

const computeAutoRange = (klines: Awaited<ReturnType<typeof getKlines>>) => {
  const lows = klines.map((k) => k.low);
  const highs = klines.map((k) => k.high);
  const closes = klines.map((k) => k.close);
  const first = klines[0];
  const last = klines[klines.length - 1];
  if (!first || !last) return null;

  const lower = percentile(lows, 0.1);
  const upper = percentile(highs, 0.9);
  if (!lower || !upper || lower <= 0 || upper <= 0 || upper <= lower) return null;
  const mid = (lower + upper) / 2;
  const rangePct = ((upper - lower) / mid) * 100;
  const trendPct = (Math.abs(last.close - first.open) / mid) * 100;
  const trendRatio = rangePct > 0 ? trendPct / rangePct : 1;
  const lastClose = closes[closes.length - 1];
  if (!Number.isFinite(lastClose)) return null;
  return { lower, upper, mid, rangePct, trendPct, trendRatio, lastClose };
};

const clampLevelsByMinStep = (lower: number, upper: number, requested: number) => {
  let levels = Math.max(2, Math.floor(requested));
  const minStepPct = Math.max(0.01, config.gridMinStepPct);
  while (levels > 2) {
    const ratio = Math.pow(upper / lower, 1 / (levels - 1));
    const stepPct = (ratio - 1) * 100;
    if (stepPct >= minStepPct) break;
    levels -= 1;
  }
  return levels;
};

const scoreGridCandidate = (snap: Awaited<ReturnType<typeof get24hStats>>, range: { rangePct: number; trendRatio: number }) => {
  const liquidity = Math.max(snap.quoteVolume ?? 0, 1);
  const liquidityScore = Math.log10(liquidity);
  const regimeScore = Math.max(0, 1 - range.trendRatio);
  return liquidityScore * range.rangePct * regimeScore;
};

export const refreshGridCandidates = async () => {
  if (config.tradeVenue !== 'spot') return { best: null as string | null, candidates: [] as { symbol: string; score: number }[] };
  if (!config.gridEnabled) return { best: null as string | null, candidates: [] as { symbol: string; score: number }[] };

  const now = Date.now();
  const last = persisted.meta?.gridUpdatedAt ?? 0;
  if (now - last < Math.max(30_000, config.gridRebalanceSeconds * 1000)) {
    const cached = persisted.meta?.rankedGridCandidates ?? [];
    return { best: cached[0]?.symbol ?? null, candidates: cached };
  }

  const symbols = await fetchTradableSymbols();
  const home = config.homeAsset.toUpperCase();
  const blocked = new Set(config.blacklistSymbols.map((s) => s.toUpperCase()));
  for (const key of Object.keys(persisted.meta?.accountBlacklist ?? {})) blocked.add(key.toUpperCase());

  const universe =
    config.gridSymbols.length > 0
      ? config.gridSymbols.map((s) => s.toUpperCase())
      : (persisted.meta?.rankedCandidates?.map((c) => c.symbol.toUpperCase()) ?? []).slice(0, config.universeMaxSymbols);

  const coarse: { symbol: string; snap: Awaited<ReturnType<typeof get24hStats>> }[] = [];
  for (const sym of universe) {
    if (blocked.has(sym)) continue;
    const info = findSymbolInfo(symbols, sym);
    if (!info || !isSpotTradable(info)) continue;
    if (info.quoteAsset.toUpperCase() !== home) continue;
    if (isStableLikeAsset(info.baseAsset) && isStableLikeAsset(info.quoteAsset)) continue;
    if (looksLeverageToken(sym)) continue;
    try {
      const snap = await get24hStats(sym);
      const volPct = Math.abs((snap.highPrice - snap.lowPrice) / Math.max(snap.price, 0.00000001)) * 100;
      const momentum = Math.abs(snap.priceChangePercent);
      if (volPct < config.gridMinRangePct || volPct > config.gridMaxRangePct) continue;
      if (momentum > Math.max(1.5, config.gridMinRangePct)) continue;
      if ((snap.quoteVolume ?? 0) < config.minQuoteVolume) continue;
      coarse.push({ symbol: sym, snap });
    } catch {
      // skip symbol if snapshot fails
    }
  }

  coarse.sort((a, b) => (b.snap.quoteVolume ?? 0) - (a.snap.quoteVolume ?? 0));
  const shortlist = coarse.slice(0, 8);

  const candidates: { symbol: string; score: number }[] = [];
  for (const item of shortlist) {
    try {
      const klines = await getKlines(item.symbol, config.gridKlineInterval, config.gridKlineLimit);
      const range = computeAutoRange(klines);
      if (!range) continue;
      if (range.rangePct < config.gridMinRangePct || range.rangePct > config.gridMaxRangePct) continue;
      if (range.trendRatio > config.gridMaxTrendRatio) continue;
      candidates.push({ symbol: item.symbol, score: scoreGridCandidate(item.snap, range) });
    } catch {
      // ignore
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  persistMeta(persisted, { rankedGridCandidates: candidates.slice(0, 50), gridUpdatedAt: now });
  return { best: candidates[0]?.symbol ?? null, candidates };
};

const buildGridState = async (symbol: string, balances: Balance[], symbols: SymbolInfo[], allocationHome: number): Promise<GridState> => {
  const info = findSymbolInfo(symbols, symbol);
  if (!info) throw new Error(`Unknown symbol ${symbol}`);
  if (!isSpotTradable(info)) throw new Error(`Symbol ${symbol} not tradable on spot`);
  const home = config.homeAsset.toUpperCase();
  if (info.quoteAsset.toUpperCase() !== home) {
    throw new Error(`Grid requires quoteAsset=${home}. ${symbol} quote is ${info.quoteAsset}`);
  }
  if (isStableLikeAsset(info.baseAsset) && isStableLikeAsset(info.quoteAsset)) {
    throw new Error('Grid disabled for stable-to-stable pairs');
  }
  if (looksLeverageToken(symbol)) {
    throw new Error('Grid disabled for leverage tokens');
  }

  const klines = await getKlines(symbol, config.gridKlineInterval, config.gridKlineLimit);
  const range = computeAutoRange(klines);
  if (!range) throw new Error('Unable to derive auto range from klines');
  if (range.rangePct < config.gridMinRangePct || range.rangePct > config.gridMaxRangePct) {
    throw new Error(`Range ${range.rangePct.toFixed(2)}% outside ${config.gridMinRangePct}-${config.gridMaxRangePct}%`);
  }
  if (range.trendRatio > config.gridMaxTrendRatio) {
    throw new Error(`Trend ratio ${range.trendRatio.toFixed(2)} above cap ${config.gridMaxTrendRatio}`);
  }

  const levels = clampLevelsByMinStep(range.lower, range.upper, config.gridLevels);
  const prices = geometricGrid(range.lower, range.upper, levels).map((p) => floorToTick(p, info.tickSize));
  const usableLevels = Math.max(2, prices.filter((p) => Number.isFinite(p) && p > 0).length);

  const maxAlloc = Math.max(0, allocationHome);
  const orderCount = Math.max(1, usableLevels - 1);
  const orderNotionalHome = maxAlloc / orderCount;

  const createdAt = Date.now();
  const allocation = Math.max(0, maxAlloc);
  return {
    symbol: symbol.toUpperCase(),
    status: 'running',
    baseAsset: info.baseAsset.toUpperCase(),
    quoteAsset: info.quoteAsset.toUpperCase(),
    homeAsset: home,
    lowerPrice: range.lower,
    upperPrice: range.upper,
    levels: usableLevels,
    prices: prices.slice(0, usableLevels),
    orderNotionalHome,
    allocationHome: allocation,
    bootstrapBasePct: Math.max(0, Math.min(100, config.gridBootstrapBasePct)),
    createdAt,
    updatedAt: createdAt,
    ordersByLevel: {},
    performance: {
      startAt: createdAt,
      startValueHome: allocation,
      lastAt: createdAt,
      lastValueHome: allocation,
      pnlHome: 0,
      pnlPct: 0,
      baseVirtual: 0,
      quoteVirtual: allocation,
      feesHome: 0,
      fillsBuy: 0,
      fillsSell: 0,
      breakouts: 0,
      lastFillAt: undefined,
    },
  };
};

const ensureBootstrapBase = async (grid: GridState, info: SymbolInfo, balances: Balance[], currentPrice: number) => {
  if (!config.tradingEnabled) return { balances, grid };
  const base = grid.baseAsset.toUpperCase();
  const quote = grid.quoteAsset.toUpperCase();
  const freeBy = balanceFreeMap(balances);
  const freeBase = freeBy.get(base) ?? 0;
  const freeQuote = freeBy.get(quote) ?? 0;

  const targetQuoteSpend = (grid.allocationHome * grid.bootstrapBasePct) / 100;
  if (targetQuoteSpend <= 0) return { balances, grid };
  if (freeQuote <= 0) return { balances, grid };

  // Buy base inventory up to the configured bootstrap percentage.
  const desiredBase = targetQuoteSpend / Math.max(currentPrice, 0.00000001);
  const missing = desiredBase - freeBase;
  const qty = floorToStep(Math.max(0, missing), info.stepSize);
  if (!Number.isFinite(qty) || qty <= 0) return { balances, grid };
  if (info.minQty && qty < info.minQty) return { balances, grid };
  if (info.minNotional && qty * Math.max(currentPrice, 0.00000001) < info.minNotional) {
    // Close enough, but the top-up is below Binance minimums (avoid noisy retries).
    return { balances, grid };
  }

  try {
    const order = await placeOrder({ symbol: grid.symbol, side: 'BUY', quantity: qty, type: 'MARKET' });
    const now = Date.now();
    const fill = extractGridFillRow(grid.symbol, order, now);
    if (fill) persistGridFill(fill);
    const perf = ensurePerformance(grid, now);
    const nextPerf = applyFillToPerformance(perf, order, now);
    grid = { ...grid, performance: nextPerf };
    persistGrid(persisted, grid.symbol, grid);
    const refreshed = await getBalances();
    return { balances: refreshed, grid };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), symbol: grid.symbol }, 'Grid bootstrap buy failed');
    return { balances, grid };
  }
};

const cancelGridOrders = async (grid: GridState) => {
  if (config.tradeVenue !== 'spot') return;
  if (!config.tradingEnabled) return;
  const orderIds = Object.values(grid.ordersByLevel)
    .map((o) => o.orderId)
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!orderIds.length) return;
  for (const orderId of orderIds) {
    try {
      await cancelOrder(grid.symbol, orderId);
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol: grid.symbol, orderId }, 'Cancel grid order failed');
    }
  }
};

const liquidateGridBaseToHome = async (
  grid: GridState,
  info: SymbolInfo,
  balances: Balance[],
  price: number,
): Promise<NonNullable<GridState['performance']> | null> => {
  if (config.tradeVenue !== 'spot') return null;
  if (!config.tradingEnabled) return null;

  const base = grid.baseAsset.toUpperCase();
  const quote = grid.quoteAsset.toUpperCase();
  if (quote !== config.homeAsset.toUpperCase()) return null;

  const freeBy = balanceFreeMap(balances);
  const freeBase = freeBy.get(base) ?? 0;
  const now = Date.now();
  const perf = ensurePerformance(grid, now);
  const maxQty = Math.min(Math.max(0, freeBase), Math.max(0, perf.baseVirtual ?? 0));
  const qty = floorToStep(Math.max(0, maxQty), info.stepSize);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (info.minQty && qty < info.minQty) return null;
  if (info.minNotional && qty * Math.max(price, 0.00000001) < info.minNotional) return null;

  try {
    const order = await placeOrder({ symbol: grid.symbol, side: 'SELL', quantity: qty, type: 'MARKET' });
    const fill = extractGridFillRow(grid.symbol, order, now);
    if (fill) persistGridFill(fill);
    const nextPerf = applyFillToPerformance(perf, order, now);
    return nextPerf;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), symbol: grid.symbol }, 'Grid liquidation sell failed');
    return null;
  }
};

const reconcileGridOrders = async (grid: GridState, info: SymbolInfo, balances: Balance[]) => {
  const now = Date.now();
  const snap = await get24hStats(grid.symbol);
  const current = snap.price;
  if (!Number.isFinite(current) || current <= 0) throw new Error('Invalid market price');

  const perf0 = ensurePerformance(grid, now);

  const bufferPct = Math.max(0, config.gridBreakoutBufferPct) / 100;
  if (config.gridBreakoutAction !== 'none') {
    if (current < grid.lowerPrice * (1 - bufferPct) || current > grid.upperPrice * (1 + bufferPct)) {
      await cancelGridOrders(grid);
      let perfAfterLiquidation: NonNullable<GridState['performance']> | null = null;
      if (config.gridBreakoutAction === 'cancel_and_liquidate') {
        perfAfterLiquidation = await liquidateGridBaseToHome(grid, info, balances, current);
      }
      const reason = `Breakout: price ${current} outside [${grid.lowerPrice}, ${grid.upperPrice}]`;
      const breakouts = Math.max(0, Math.floor(perfAfterLiquidation?.breakouts ?? perf0.breakouts ?? 0)) + 1;
      const perf = revaluePerformance(
        { ...(perfAfterLiquidation ?? perf0), breakouts },
        now,
        current,
      );
      const stopped: GridState = {
        ...grid,
        status: 'stopped',
        updatedAt: now,
        lastTickAt: now,
        lastError: reason,
        ordersByLevel: {},
        performance: perf,
      };
      persistGrid(persisted, grid.symbol, stopped);
      logger.warn({ symbol: grid.symbol, price: current, lower: grid.lowerPrice, upper: grid.upperPrice }, 'Grid stopped on breakout');
      return stopped;
    }
  }

  // Bootstrap base inventory for neutral grids.
  const boot = await ensureBootstrapBase(grid, info, balances, current);
  balances = boot.balances;
  grid = boot.grid;

  const freeBy = balanceFreeMap(balances);
  const base = grid.baseAsset.toUpperCase();
  const quote = grid.quoteAsset.toUpperCase();
  let freeBase = freeBy.get(base) ?? 0;
  let freeQuote = freeBy.get(quote) ?? 0;

  const openOrders = await getOpenOrders(grid.symbol);
  const openById = new Set<number>();
  const openBySideAndPrice = new Map<string, { orderId: number; qty: number }>();
  for (const row of openOrders) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const orderId = Number(rec.orderId);
    const side = String(rec.side ?? '').toUpperCase();
    const price = Number(rec.price);
    const origQty = Number(rec.origQty ?? rec.quantity ?? 0);
    if (!Number.isFinite(orderId) || orderId <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    openById.add(orderId);
    const key = `${side}:${price.toFixed(decimalsForStep(info.tickSize))}`;
    openBySideAndPrice.set(key, { orderId, qty: origQty });
  }

  // Drop stale orders we no longer see as open.
  const nextOrdersByLevel: Record<string, GridOrder> = {};
  const droppedOrders: GridOrder[] = [];
  for (const [levelKey, order] of Object.entries(grid.ordersByLevel ?? {})) {
    if (openById.has(order.orderId)) {
      nextOrdersByLevel[levelKey] = { ...order, lastSeenAt: now };
    } else {
      droppedOrders.push(order);
    }
  }

  let perf = ensurePerformance(grid, now);
  // Attempt to reconcile any filled/canceled orders that disappeared from open-orders.
  // This is best-effort and rate-friendly: only check a small number per tick.
  let checked = 0;
  const maxChecks = 12;
  for (const order of droppedOrders) {
    if (checked >= maxChecks) break;
    checked += 1;
    try {
      const detail = await getOrder(grid.symbol, order.orderId);
      perf = applyFillToPerformance(perf, detail, now);
      const fill = extractGridFillRow(grid.symbol, detail, now);
      if (fill) persistGridFill(fill);
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol: grid.symbol, orderId: order.orderId }, 'Grid fill reconcile failed');
    }
  }

  // Track how much of the grid's virtual inventory is already committed in open orders (best-effort).
  // Prevents the grid engine from allocating beyond the configured GRID_MAX_ALLOC_PCT budget.
  let gridAvailableQuote = clampNonNegative(
    (perf.quoteVirtual ?? 0) -
      Object.values(nextOrdersByLevel)
        .filter((o) => o.side === 'BUY')
        .reduce((sum, o) => sum + o.quantity * o.price, 0),
  );
  let gridAvailableBase = clampNonNegative(
    (perf.baseVirtual ?? 0) -
      Object.values(nextOrdersByLevel)
        .filter((o) => o.side === 'SELL')
        .reduce((sum, o) => sum + o.quantity, 0),
  );

  let placedThisTick = 0;

  for (let i = 0; i < grid.prices.length; i += 1) {
    if (placedThisTick >= config.gridMaxNewOrdersPerTick) break;
    const levelPrice = floorToTick(grid.prices[i] ?? 0, info.tickSize);
    if (!Number.isFinite(levelPrice) || levelPrice <= 0) continue;
    if (inGap(levelPrice, current)) continue;

    const side: 'BUY' | 'SELL' = levelPrice < current ? 'BUY' : 'SELL';
    const levelKey = String(i);

    // If we already track an open order for this level and it matches, keep it.
    const existing = nextOrdersByLevel[levelKey];
    if (existing && existing.side === side && Math.abs(existing.price - levelPrice) <= (info.tickSize ?? 0)) {
      continue;
    }

    // If Binance has an open order at this exact side+price (e.g., after restart), import it.
    const lookupKey = `${side}:${levelPrice.toFixed(decimalsForStep(info.tickSize))}`;
    const openMatch = openBySideAndPrice.get(lookupKey);
    if (openMatch) {
      nextOrdersByLevel[levelKey] = {
        orderId: openMatch.orderId,
        side,
        price: levelPrice,
        quantity: openMatch.qty,
        placedAt: now,
        lastSeenAt: now,
      };
      if (side === 'BUY') {
        gridAvailableQuote = Math.max(0, gridAvailableQuote - openMatch.qty * levelPrice);
      } else {
        gridAvailableBase = Math.max(0, gridAvailableBase - openMatch.qty);
      }
      continue;
    }

    // Otherwise place a fresh grid order for this level.
    const rawQty = grid.orderNotionalHome / Math.max(levelPrice, 0.00000001);
    const qty = floorToStep(rawQty, info.stepSize);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const minQty = info.minQty ?? 0;
    if (minQty > 0 && qty < minQty) continue;
    const minNotional = info.minNotional ?? 0;
    if (minNotional > 0 && qty * levelPrice < minNotional) continue;

    if (side === 'BUY') {
      const required = qty * levelPrice;
      if (required <= 0 || freeQuote < required) continue;
      if (gridAvailableQuote < required) continue;
      try {
        const order = await placeOrder({ symbol: grid.symbol, side, quantity: qty, price: levelPrice, type: 'LIMIT' });
        const orderId = Number((order as { orderId?: string | number } | undefined)?.orderId ?? 0);
        if (Number.isFinite(orderId) && orderId > 0) {
          nextOrdersByLevel[levelKey] = { orderId, side, price: levelPrice, quantity: qty, placedAt: now, lastSeenAt: now };
          freeQuote -= required;
          gridAvailableQuote = Math.max(0, gridAvailableQuote - required);
          placedThisTick += 1;
        }
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), symbol: grid.symbol, side, price: levelPrice }, 'Grid order placement failed');
      }
    } else {
      if (freeBase < qty) continue;
      if (gridAvailableBase < qty) continue;
      try {
        const order = await placeOrder({ symbol: grid.symbol, side, quantity: qty, price: levelPrice, type: 'LIMIT' });
        const orderId = Number((order as { orderId?: string | number } | undefined)?.orderId ?? 0);
        if (Number.isFinite(orderId) && orderId > 0) {
          nextOrdersByLevel[levelKey] = { orderId, side, price: levelPrice, quantity: qty, placedAt: now, lastSeenAt: now };
          freeBase -= qty;
          gridAvailableBase = Math.max(0, gridAvailableBase - qty);
          placedThisTick += 1;
        }
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), symbol: grid.symbol, side, price: levelPrice }, 'Grid order placement failed');
      }
    }
  }

  perf = revaluePerformance(perf, now, current);
  const updated: GridState = {
    ...grid,
    status: 'running',
    updatedAt: now,
    lastTickAt: now,
    lastError: undefined,
    ordersByLevel: nextOrdersByLevel,
    performance: perf,
  };
  persistGrid(persisted, grid.symbol, updated);
  return updated;
};

export const startOrSyncGrids = async () => {
  if (!config.gridEnabled) return;
  if (config.tradeVenue !== 'spot') return;

  const now = Date.now();
  const last = persisted.meta?.gridRebalanceAt ?? 0;
  if (now - last < config.gridRebalanceSeconds * 1000) return;

  persistMeta(persisted, { gridRebalanceAt: now });

  let balances: Balance[] = [];
  try {
    balances = await getBalances();
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Grid tick: failed to load balances');
    return;
  }

  const symbols = await fetchTradableSymbols();
  const home = config.homeAsset.toUpperCase();
  const freeBy = balanceFreeMap(balances);
  const freeHome = freeBy.get(home) ?? 0;
  const maxAllocHome = (freeHome * config.gridMaxAllocPct) / 100;

  const existing = Object.values(persisted.grids ?? {}).filter((g) => g && g.status === 'running');
  const stoppedSymbols = new Set(
    Object.values(persisted.grids ?? {})
      .filter((g) => g && g.status === 'stopped')
      .map((g) => g.symbol.toUpperCase()),
  );
  let desiredSymbols: string[] = [];

  if (config.gridSymbols.length > 0) {
    desiredSymbols = config.gridSymbols.map((s) => s.toUpperCase()).slice(0, config.gridMaxActiveGrids);
  } else if (config.gridAutoDiscover) {
    const discovered = await refreshGridCandidates();
    desiredSymbols = discovered.candidates.map((c) => c.symbol.toUpperCase()).slice(0, config.gridMaxActiveGrids);
  }

  // Ensure we have at most GRID_MAX_ACTIVE_GRIDS running grids.
  const runningSymbols = new Set(existing.map((g) => g.symbol.toUpperCase()));
  const toStart = desiredSymbols.filter((s) => !runningSymbols.has(s) && !stoppedSymbols.has(s));

  const allocated = existing.reduce((sum, g) => sum + (g.allocationHome ?? 0), 0);
  const remaining = Math.max(0, maxAllocHome - allocated);
  const perGridAlloc =
    toStart.length > 0 ? Math.max(0, remaining / Math.max(1, toStart.length)) : 0;

  for (const sym of toStart) {
    if (Object.values(persisted.grids ?? {}).filter((g) => g && g.status === 'running').length >= config.gridMaxActiveGrids) break;
    if (perGridAlloc <= 0) break;
    try {
      const grid = await buildGridState(sym, balances, symbols, perGridAlloc);
      persistGrid(persisted, grid.symbol, grid);
      logger.info({ symbol: grid.symbol, lower: grid.lowerPrice, upper: grid.upperPrice, levels: grid.levels }, 'Grid started');
    } catch (error) {
      const message = errorToString(error);
      const stub: GridState = {
        symbol: sym.toUpperCase(),
        status: 'error',
        baseAsset: '',
        quoteAsset: home,
        homeAsset: home,
        lowerPrice: 0,
        upperPrice: 0,
        levels: 0,
        prices: [],
        orderNotionalHome: 0,
        allocationHome: 0,
        bootstrapBasePct: Math.max(0, Math.min(100, config.gridBootstrapBasePct)),
        createdAt: now,
        updatedAt: now,
        lastTickAt: now,
        lastError: message,
        ordersByLevel: {},
      };
      persistGrid(persisted, sym, stub);
      logger.warn({ symbol: sym, err: errorToLogObject(error) }, 'Grid start failed');
    }
  }

  // Run reconcile for all running grids.
  for (const grid of Object.values(persisted.grids ?? {})) {
    if (!grid || grid.status !== 'running') continue;
    const info = findSymbolInfo(symbols, grid.symbol);
    if (!info) continue;
    try {
      await reconcileGridOrders(grid, info, balances);
    } catch (error) {
      const message = errorToString(error);
      const failed: GridState = { ...grid, status: 'error', updatedAt: now, lastTickAt: now, lastError: message };
      persistGrid(persisted, grid.symbol, failed);
      logger.warn({ symbol: grid.symbol, err: errorToLogObject(error) }, 'Grid tick failed');
    }
  }
};

export const startGrid = async (symbolInput: string) => {
  if (config.tradeVenue !== 'spot') return { ok: false, error: 'Grid is only available in spot mode.' };
  if (!config.gridEnabled) return { ok: false, error: 'GRID_ENABLED=false (enable grid mode in .env)' };

  const symbol = symbolInput.toUpperCase();
  const existing = persisted.grids?.[symbol];
  if (existing?.status === 'running') return { ok: true };

  const runningCount = Object.values(persisted.grids ?? {}).filter((g) => g && g.status === 'running').length;
  if (runningCount >= config.gridMaxActiveGrids) {
    return { ok: false, error: `Max active grids reached (${config.gridMaxActiveGrids}). Stop another grid first.` };
  }

  let balances: Balance[];
  try {
    balances = await getBalances();
  } catch (error) {
    return { ok: false, error: `Failed to fetch balances: ${errorToString(error)}` };
  }

  const symbols = await fetchTradableSymbols();
  const home = config.homeAsset.toUpperCase();
  const freeBy = balanceFreeMap(balances);
  const freeHome = freeBy.get(home) ?? 0;
  const maxAllocHome = (freeHome * config.gridMaxAllocPct) / 100;
  const allocated = Object.values(persisted.grids ?? {})
    .filter((g) => g && g.status === 'running')
    .reduce((sum, g) => sum + (g.allocationHome ?? 0), 0);
  const remaining = Math.max(0, maxAllocHome - allocated);
  if (remaining <= 0) {
    return { ok: false, error: `No remaining grid allocation (cap ${config.gridMaxAllocPct}% of free ${home}).` };
  }

  try {
    const grid = await buildGridState(symbol, balances, symbols, remaining);
    persistGrid(persisted, grid.symbol, grid);

    const info = findSymbolInfo(symbols, grid.symbol);
    if (info && config.tradingEnabled) {
      void reconcileGridOrders(grid, info, balances);
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorToString(error) };
  }
};

export const stopGrid = async (symbolInput: string) => {
  if (config.tradeVenue !== 'spot') return { ok: false, error: 'Grid is only available in spot mode.' };
  if (!config.gridEnabled) return { ok: false, error: 'GRID_ENABLED=false (enable grid mode in .env)' };

  const symbol = symbolInput.toUpperCase();
  const existing = persisted.grids?.[symbol];
  if (!existing) return { ok: false, error: `No grid found for ${symbol}` };

  try {
    await cancelGridOrders(existing);
  } catch {
    // ignore
  }

  const now = Date.now();
  const stopped: GridState = { ...existing, status: 'stopped', updatedAt: now, lastTickAt: now, ordersByLevel: {} };
  persistGrid(persisted, symbol, stopped);
  return { ok: true };
};
