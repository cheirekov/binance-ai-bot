import { getLatestPrice, getMyTrades, getOpenOrders, getOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';
import { getPersistedState } from './persistence.js';
import { persistTradeFillsBatch } from './sqlite.js';

type TradeModule = 'grid' | 'portfolio';

type TrackedOrder = {
  symbol: string;
  orderId: string;
  module: TradeModule;
  side: 'BUY' | 'SELL' | null;
  status: string;
  executedQty: number;
};

type SyncTask = { symbol: string; orderId: string; module: TradeModule; side?: 'BUY' | 'SELL' | null };

const persisted = getPersistedState();

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const buildGridOrderIdSet = () => {
  const ids = new Set<string>();
  if (config.tradeVenue !== 'spot') return ids;
  for (const grid of Object.values(persisted.grids ?? {})) {
    if (!grid) continue;
    for (const o of Object.values(grid.ordersByLevel ?? {})) {
      const id = o?.orderId;
      if (id === undefined || id === null) continue;
      const str = String(id);
      if (str && str !== 'undefined') ids.add(str);
    }
  }
  return ids;
};

let prevOpenOrders = new Map<string, TrackedOrder>();

const orderSnapshots = new Map<string, { executedQty: number; status: string }>();

const syncQueue: SyncTask[] = [];
const syncInFlight = new Set<string>();
const lastEnqueuedAt = new Map<string, number>();
let syncPumpScheduled = false;

const SYNC_QUEUE_MAX = 500;
const SYNC_CONCURRENCY = 2;
const SYNC_DEBOUNCE_MS = 1_000;

const missingCheckQueue: Array<{ order: TrackedOrder; attempts: number }> = [];
const missingCheckSet = new Set<string>();
const MISSING_QUEUE_MAX = 2_000;
const MAX_MISSING_CHECKS_PER_TICK = 20;
const MAX_MISSING_ATTEMPTS = 3;

const enqueueMissingCheck = (order: TrackedOrder) => {
  const key = `${order.symbol.toUpperCase()}:${String(order.orderId)}`;
  if (missingCheckSet.has(key)) return;

  if (missingCheckQueue.length >= MISSING_QUEUE_MAX) {
    const dropped = missingCheckQueue.splice(0, Math.max(1, Math.floor(MISSING_QUEUE_MAX / 10)));
    for (const d of dropped) {
      const dk = `${d.order.symbol.toUpperCase()}:${String(d.order.orderId)}`;
      missingCheckSet.delete(dk);
    }
    logger.warn({ dropped: true }, 'trade-sync: missing-order queue overflow (dropping oldest)');
  }

  missingCheckSet.add(key);
  missingCheckQueue.push({ order, attempts: 0 });
};

const enqueueSync = (task: SyncTask) => {
  const key = `${task.symbol.toUpperCase()}:${task.orderId}`;
  if (syncInFlight.has(key)) return;

  const now = Date.now();
  const last = lastEnqueuedAt.get(key) ?? 0;
  if (now - last < SYNC_DEBOUNCE_MS) return;
  lastEnqueuedAt.set(key, now);

  if (syncQueue.length >= SYNC_QUEUE_MAX) {
    syncQueue.splice(0, Math.max(1, Math.floor(SYNC_QUEUE_MAX / 10)));
    logger.warn({ dropped: true }, 'trade-sync: queue overflow (dropping oldest)');
  }

  syncQueue.push({ ...task, symbol: task.symbol.toUpperCase(), orderId: String(task.orderId) });
  scheduleSyncPump();
};

const scheduleSyncPump = () => {
  if (syncPumpScheduled) return;
  syncPumpScheduled = true;
  setTimeout(() => {
    syncPumpScheduled = false;
    void pumpSyncQueue();
  }, 0);
};

const pumpSyncQueue = async () => {
  while (syncQueue.length && syncInFlight.size < SYNC_CONCURRENCY) {
    const task = syncQueue.shift();
    if (!task) break;
    const key = `${task.symbol.toUpperCase()}:${task.orderId}`;
    if (syncInFlight.has(key)) continue;
    syncInFlight.add(key);
    void syncTradesForOrder(task.symbol, task.orderId, task.module, task.side ?? undefined)
      .catch((error) => {
        logger.warn(
          { err: errorToLogObject(error), symbol: task.symbol, orderId: task.orderId, module: task.module },
          'trade-sync: sync failed',
        );
      })
      .finally(() => {
        syncInFlight.delete(key);
        scheduleSyncPump();
      });
  }
};

const observeOrder = (order: TrackedOrder) => {
  const symbol = order.symbol.toUpperCase();
  const orderId = String(order.orderId);
  const key = `${symbol}:${orderId}`;
  const status = (order.status ?? '').toUpperCase();
  const executedQty = Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : 0;

  const prev = orderSnapshots.get(key);
  const prevQty = prev?.executedQty ?? 0;
  const prevStatus = prev?.status ?? '';

  const fillStatus = status === 'PARTIALLY_FILLED' || status === 'FILLED';
  const statusTrigger = fillStatus && prevStatus !== status;
  const qtyTrigger = executedQty > prevQty + 1e-12;

  orderSnapshots.set(key, { executedQty, status });

  if (statusTrigger || qtyTrigger) {
    enqueueSync({ symbol, orderId, module: order.module, side: order.side });
  }
};

const bestEffortAssetToAssetRate = async (fromAsset: string, toAsset: string): Promise<number | null> => {
  const from = fromAsset.toUpperCase();
  const to = toAsset.toUpperCase();
  if (!from || !to) return null;
  if (from === to) return 1;

  const cacheKey = `${from}:${to}`;
  const cached = rateCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < RATE_CACHE_TTL_MS) return cached.rate;

  let out: number | null = null;
  try {
    const symbols = await fetchTradableSymbols();
    const direct = symbols.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
    );
    const inverse = symbols.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
    );

    if (direct) {
      const p = await getLatestPrice(direct.symbol);
      out = Number.isFinite(p) && p > 0 ? p : null;
    } else if (inverse) {
      const p = await getLatestPrice(inverse.symbol);
      out = Number.isFinite(p) && p > 0 ? 1 / p : null;
    }
  } catch {
    out = null;
  }

  rateCache.set(cacheKey, { rate: out, fetchedAt: now });
  return out;
};

const bestEffortAssetToHomeRate = async (asset: string, home: string): Promise<number | null> => {
  const a = asset.toUpperCase();
  const h = home.toUpperCase();
  if (!a || !h) return null;
  if (a === h) return 1;

  const direct = await bestEffortAssetToAssetRate(a, h);
  if (direct) return direct;

  const mids = ['USDC', 'USDT', 'FDUSD', 'BTC', 'ETH', 'BNB'];
  for (const mid of mids) {
    const m = mid.toUpperCase();
    if (m === a || m === h) continue;
    const leg1 = await bestEffortAssetToAssetRate(a, m);
    if (!leg1) continue;
    const leg2 = await bestEffortAssetToAssetRate(m, h);
    if (!leg2) continue;
    return leg1 * leg2;
  }

  return null;
};

const rateCache = new Map<string, { rate: number | null; fetchedAt: number }>();
const RATE_CACHE_TTL_MS = 30_000;

export const syncTradesForOrder = async (
  symbolInput: string,
  orderIdInput: string | number,
  module: TradeModule,
  sideHint?: 'BUY' | 'SELL' | null,
): Promise<void> => {
  if (!config.persistToSqlite) return;
  if (!config.tradingEnabled) return;
  if (config.tradeVenue !== 'spot') return;

  const symbol = symbolInput.toUpperCase();
  const orderId = String(orderIdInput);
  if (!symbol || !orderId) return;

  let rows: unknown[] = [];
  try {
    rows = await getMyTrades(symbol, { orderId });
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), symbol, orderId }, 'trade-sync: myTrades failed');
    return;
  }

  if (!rows.length) {
    // Fallback: some API clients ignore orderId param; filter manually as a best-effort.
    try {
      const fallback = await getMyTrades(symbol, { limit: 1000 });
      rows = fallback.filter((t) => {
        if (!t || typeof t !== 'object') return false;
        const rec = t as Record<string, unknown>;
        const oid = rec.orderId !== undefined && rec.orderId !== null ? String(rec.orderId) : null;
        return oid === orderId;
      });
    } catch {
      rows = [];
    }
  }

  if (!rows.length) return;

  let quoteAsset: string | undefined;
  try {
    const symbols = await fetchTradableSymbols();
    const info = symbols.find((s) => s.symbol.toUpperCase() === symbol);
    quoteAsset = info?.quoteAsset ? info.quoteAsset.toUpperCase() : undefined;
  } catch {
    quoteAsset = undefined;
  }

  const homeAsset = config.homeAsset.toUpperCase();

  const parsedTrades: Array<{
    at: number;
    symbol: string;
    module: TradeModule;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    notional: number;
    feeAsset?: string;
    feeAmount?: number;
    feesHome?: number;
    tradeId?: string;
  }> = [];

  let missingTradeId = false;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const tradeOrderId = rec.orderId !== undefined && rec.orderId !== null ? String(rec.orderId) : null;
    if (tradeOrderId !== orderId) continue;

    const at = toNumberOrNull(rec.time) ?? Date.now();
    const qty = toNumberOrNull(rec.qty ?? rec.quantity) ?? null;
    const price = toNumberOrNull(rec.price) ?? null;
    const quoteQty = toNumberOrNull(rec.quoteQty) ?? null;
    if (!qty || qty <= 0) continue;
    if (!price || price <= 0) continue;

    const notional = quoteQty && quoteQty > 0 ? quoteQty : qty * price;
    if (!Number.isFinite(notional) || notional <= 0) continue;

    const isBuyer = typeof rec.isBuyer === 'boolean' ? rec.isBuyer : null;
    const side: 'BUY' | 'SELL' | null = isBuyer === true ? 'BUY' : isBuyer === false ? 'SELL' : sideHint ?? null;
    if (!side) continue;

    const feeAmount = toNumberOrNull(rec.commission);
    const feeAsset = typeof rec.commissionAsset === 'string' ? rec.commissionAsset.toUpperCase() : null;

    let feesHome: number | undefined;
    if (feeAmount !== null && feeAmount >= 0 && feeAsset) {
      if (feeAsset === homeAsset) {
        feesHome = feeAmount;
      } else {
        const rate = await bestEffortAssetToHomeRate(feeAsset, homeAsset);
        if (rate && Number.isFinite(rate) && rate > 0) {
          feesHome = feeAmount * rate;
        }
      }
    }

    const tradeId = rec.id !== undefined && rec.id !== null ? String(rec.id) : null;
    if (!tradeId) missingTradeId = true;

    parsedTrades.push({
      at,
      symbol,
      module,
      side,
      qty,
      price,
      notional,
      feeAsset: feeAsset ?? undefined,
      feeAmount: feeAmount ?? undefined,
      feesHome,
      tradeId: tradeId ?? undefined,
    });
  }

  if (!parsedTrades.length) return;

  if (missingTradeId) {
    // Binance should always provide tradeId. If it doesn't, fall back to a single aggregated fill row.
    const first = parsedTrades[0];
    if (!first) return;

    const totalQty = parsedTrades.reduce((sum, t) => sum + (Number.isFinite(t.qty) ? t.qty : 0), 0);
    const totalNotional = parsedTrades.reduce((sum, t) => sum + (Number.isFinite(t.notional) ? t.notional : 0), 0);
    const avgPrice = totalQty > 0 && totalNotional > 0 ? totalNotional / totalQty : null;
    if (!avgPrice || !Number.isFinite(avgPrice) || avgPrice <= 0) return;

    const feeAssetSet = new Set(parsedTrades.map((t) => (t.feeAsset ? t.feeAsset.toUpperCase() : '')));
    feeAssetSet.delete('');
    const feeAssetAgg = feeAssetSet.size === 1 ? Array.from(feeAssetSet)[0] : null;
    const feeAmountAgg =
      feeAssetAgg && parsedTrades.every((t) => t.feeAsset && t.feeAsset.toUpperCase() === feeAssetAgg && typeof t.feeAmount === 'number')
        ? parsedTrades.reduce((sum, t) => sum + (t.feeAmount ?? 0), 0)
        : null;

    const feesHomeAgg = parsedTrades.some((t) => typeof t.feesHome === 'number')
      ? parsedTrades.reduce((sum, t) => sum + (t.feesHome ?? 0), 0)
      : null;

    persistTradeFillsBatch({
      fills: [
        {
          at: first.at,
          symbol,
          module,
          side: first.side,
          qty: totalQty,
          price: avgPrice,
          notional: totalNotional,
          feeAsset: feeAssetAgg ?? undefined,
          feeAmount: feeAmountAgg ?? undefined,
          feesHome: feesHomeAgg ?? undefined,
          quoteAsset,
          homeAsset,
          orderId,
        },
      ],
      log: { symbol, orderId, module },
    });
    return;
  }

  persistTradeFillsBatch({
    fills: parsedTrades.map((t) => ({
      at: t.at,
      symbol,
      module,
      side: t.side,
      qty: t.qty,
      price: t.price,
      notional: t.notional,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
      feesHome: t.feesHome,
      quoteAsset,
      homeAsset,
      orderId,
      tradeId: t.tradeId,
    })),
    log: { symbol, orderId, module },
  });
};

let tickInFlight = false;

export const tradeSyncTick = async (): Promise<void> => {
  if (tickInFlight) return;
  if (!config.persistToSqlite) return;
  if (!config.tradingEnabled) return;
  if (config.tradeVenue !== 'spot') return;

  tickInFlight = true;
  try {
    const gridOrderIds = buildGridOrderIdSet();

    const openRows = await getOpenOrders();
    const nextOpen = new Map<string, TrackedOrder>();

    for (const row of openRows) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const symbolRaw = rec.symbol;
      const orderIdRaw = rec.orderId;
      if (typeof symbolRaw !== 'string') continue;
      if (orderIdRaw === undefined || orderIdRaw === null) continue;

      const symbol = symbolRaw.toUpperCase();
      const orderId = String(orderIdRaw);
      if (!symbol || !orderId || orderId === 'undefined') continue;

      const status = String(rec.status ?? '').toUpperCase();
      const sideRaw = String(rec.side ?? '').toUpperCase();
      const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? (sideRaw as 'BUY' | 'SELL') : null;
      const executedQty =
        toNumberOrNull(rec.executedQty ?? rec.executedQuantity ?? rec.executed) ??
        0;
      const module: TradeModule = gridOrderIds.has(orderId) ? 'grid' : 'portfolio';

      const tracked: TrackedOrder = {
        symbol,
        orderId,
        module,
        side,
        status,
        executedQty: Number.isFinite(executedQty) && executedQty > 0 ? executedQty : 0,
      };
      nextOpen.set(`${symbol}:${orderId}`, tracked);
      observeOrder(tracked);
    }

    const missing: TrackedOrder[] = [];
    for (const [key, prev] of prevOpenOrders) {
      if (!nextOpen.has(key)) missing.push(prev);
    }

    for (const prev of missing) enqueueMissingCheck(prev);

    let checked = 0;
    while (checked < MAX_MISSING_CHECKS_PER_TICK && missingCheckQueue.length) {
      const item = missingCheckQueue.shift();
      if (!item) break;
      const prev = item.order;
      const prevKey = `${prev.symbol}:${prev.orderId}`;
      const prevSnap = orderSnapshots.get(prevKey);
      const prevQty = prevSnap?.executedQty ?? prev.executedQty ?? 0;
      const prevStatus = (prevSnap?.status ?? prev.status ?? '').toUpperCase();

      checked += 1;

      if (prevQty > 0 || prevStatus === 'PARTIALLY_FILLED') {
        enqueueSync({ symbol: prev.symbol, orderId: prev.orderId, module: prev.module, side: prev.side });
        missingCheckSet.delete(prevKey);
        continue;
      }

      try {
        const detail = await getOrder(prev.symbol, prev.orderId);
        if (detail && typeof detail === 'object') {
          const d = detail as Record<string, unknown>;
          const status = String(d.status ?? '').toUpperCase();
          const execQty = toNumberOrNull(d.executedQty ?? d.executedQuantity ?? d.origQty ?? d.quantity) ?? 0;
          const sideRaw = String(d.side ?? '').toUpperCase();
          const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? (sideRaw as 'BUY' | 'SELL') : prev.side;
          observeOrder({
            symbol: prev.symbol,
            orderId: prev.orderId,
            module: prev.module,
            side,
            status,
            executedQty: Number.isFinite(execQty) && execQty > 0 ? execQty : 0,
          });
        }
        missingCheckSet.delete(prevKey);
      } catch {
        if (item.attempts + 1 < MAX_MISSING_ATTEMPTS) {
          missingCheckQueue.push({ order: prev, attempts: item.attempts + 1 });
        } else {
          missingCheckSet.delete(prevKey);
        }
      }
    }

    prevOpenOrders = nextOpen;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'trade-sync: tick failed');
  } finally {
    tickInFlight = false;
  }
};
