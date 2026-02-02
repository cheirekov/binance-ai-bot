import { cancelOrder, get24hStats, getBalances, getOpenOrders, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getPersistedState, persistMeta } from './persistence.js';

type SymbolInfo = Awaited<ReturnType<typeof fetchTradableSymbols>>[number];

export type UnwindRunResult =
  | { ok: true; summary: { assetsQueued: string[]; ordersPlaced: number; skipped: Record<string, string> } }
  | { ok: false; error: string };

type UnwindPlan = {
  asset: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  qty: number;
  createdAt: number;
  lastRequoteAt?: number;
  orderIds?: number[];
};

const persisted = getPersistedState();

const upper = (v: string) => v.trim().toUpperCase();

const clampNonNegative = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

const parseLadderPcts = (): number[] => {
  const raw = String(config.unwindLadderPctsRaw ?? '').trim();
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 50);
  return parts.length ? parts : [0.5, 1.0, 2.0];
};

const nowBlocked = () => {
  const governorState = persisted.meta?.riskGovernor?.decision?.state ?? null;
  const emergency = persisted.meta?.emergencyStop ?? false;
  if (emergency) return { blocked: true, reason: 'Emergency stop enabled' };
  if (governorState === 'HALT') return { blocked: true, reason: 'Risk Governor HALT' };
  // Daily loss cap is surfaced as emergencyStop elsewhere; avoid introducing a second signal here.
  return { blocked: false, reason: '' };
};

const isSpotTradable = (s: SymbolInfo) =>
  s.status === 'TRADING' && ((s.permissions?.includes('SPOT') ?? false) || s.isSpotTradingAllowed);

const getBalanceTotals = (balances: Balance[]) =>
  new Map(
    balances.map((b) => [
      upper(b.asset),
      { free: clampNonNegative(b.free ?? 0), locked: clampNonNegative(b.locked ?? 0), total: clampNonNegative((b.free ?? 0) + (b.locked ?? 0)) },
    ]),
  );

const findSpotSymbol = (symbols: SymbolInfo[], baseAsset: string, quoteAsset: string) =>
  symbols.find((s) => isSpotTradable(s) && upper(s.baseAsset) === upper(baseAsset) && upper(s.quoteAsset) === upper(quoteAsset));

const floorToStep = (value: number, step?: number) => {
  if (!step) return value;
  const decimals = (() => {
    const s = String(step);
    if (s.includes('e-')) return Number(s.split('e-')[1] ?? 8);
    const [, frac] = s.split('.');
    return frac ? frac.length : 0;
  })();
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(decimals));
};

const floorToTick = (value: number, tick?: number) => {
  if (!tick) return value;
  const decimals = (() => {
    const s = String(tick);
    if (s.includes('e-')) return Number(s.split('e-')[1] ?? 8);
    const [, frac] = s.split('.');
    return frac ? frac.length : 0;
  })();
  const floored = Math.floor(value / tick) * tick;
  return Number(floored.toFixed(decimals));
};

const computeUnwantedAssets = async (): Promise<{ plans: UnwindPlan[]; skipped: Record<string, string> }> => {
  const skipped: Record<string, string> = {};
  const plans: UnwindPlan[] = [];

  if (config.tradeVenue !== 'spot') return { plans, skipped };
  if (!config.unwindEnabled) return { plans, skipped };

  const home = upper(config.homeAsset);
  const excluded = new Set((config.unwindExcludedAssets ?? []).map(upper));
  excluded.add(home);

  const activeGridBases = new Set<string>();
  const activeGridQuotes = new Set<string>();
  for (const g of Object.values(persisted.grids ?? {})) {
    if (!g) continue;
    if (g.status !== 'running') continue;
    if (g.baseAsset) activeGridBases.add(upper(g.baseAsset));
    if (g.quoteAsset) activeGridQuotes.add(upper(g.quoteAsset));
  }

  // Do not fight positions: keep base assets of open positions.
  const positionAssets = new Set<string>();
  for (const p of Object.values(persisted.positions ?? {})) {
    if (!p) continue;
    if ((p.venue ?? 'spot') !== 'spot') continue;
    if (p.baseAsset) positionAssets.add(upper(p.baseAsset));
    const sym = upper(p.symbol ?? '');
    if (sym && p.baseAsset) positionAssets.add(upper(p.baseAsset));
  }

  const symbols = await fetchTradableSymbols();
  const balances = await getBalances();
  const totals = getBalanceTotals(balances);

  for (const [asset, row] of totals.entries()) {
    const total = clampNonNegative(row.total);
    if (total <= 0) continue;
    if (asset === home) continue;

    if (excluded.has(asset)) {
      skipped[asset] = 'Excluded by UNWIND_EXCLUDED_ASSETS';
      continue;
    }
    if (activeGridBases.has(asset)) {
      skipped[asset] = 'Active grid base asset';
      continue;
    }
    if (positionAssets.has(asset)) {
      skipped[asset] = 'Reserved for open position';
      continue;
    }

    // Prefer selling to HOME directly; fallback to any active grid quote asset.
    const quoteCandidates = [home, ...Array.from(activeGridQuotes)];
    const pair = quoteCandidates
      .map((q) => ({ q, sym: findSpotSymbol(symbols, asset, q) }))
      .find((x) => !!x.sym);

    if (!pair || !pair.sym) {
      skipped[asset] = 'No spot market to unwind into HOME/active grid quotes';
      continue;
    }

    const info = pair.sym;
    const qty = floorToStep(total, info.stepSize);
    if (!Number.isFinite(qty) || qty <= 0) {
      skipped[asset] = 'Dust (below stepSize)';
      continue;
    }
    if (info.minQty && qty < info.minQty) {
      skipped[asset] = 'Dust (below minQty)';
      continue;
    }

    // Min-notional check using current price (best-effort).
    try {
      const snap = await get24hStats(info.symbol);
      const price = snap.price;
      const notional = qty * price;
      if (info.minNotional && notional < info.minNotional) {
        skipped[asset] = 'Dust (below minNotional)';
        continue;
      }
    } catch {
      // If pricing fails, still allow the plan; order placement will fail safely if constraints are violated.
    }

    plans.push({
      asset,
      symbol: upper(info.symbol),
      baseAsset: upper(info.baseAsset),
      quoteAsset: upper(info.quoteAsset),
      qty,
      createdAt: Date.now(),
    });
  }

  return { plans, skipped };
};

const cancelOpenUnwindSells = async (symbol: string) => {
  const open = await getOpenOrders(symbol);
  for (const row of open) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const side = String(rec.side ?? '').toUpperCase();
    if (side !== 'SELL') continue;
    const orderId = Number(rec.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) continue;
    try {
      await cancelOrder(symbol, orderId);
    } catch {
      // ignore
    }
  }
};

const placeLadder = async (plan: UnwindPlan) => {
  const ladder = parseLadderPcts();
  const snap = await get24hStats(plan.symbol);
  const price = snap.price;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Price unavailable');

  const symbols = await fetchTradableSymbols();
  const info = symbols.find((s) => s.symbol.toUpperCase() === plan.symbol.toUpperCase());
  if (!info) throw new Error('Symbol metadata missing');

  // Cancel old unwind sells so we don't stack ladders.
  await cancelOpenUnwindSells(plan.symbol);

  const qtyTotal = clampNonNegative(plan.qty);
  const perLeg = qtyTotal / ladder.length;

  let placed = 0;
  const orderIds: number[] = [];

  for (let i = 0; i < ladder.length; i += 1) {
    const pct = ladder[i]!;
    const rawPx = price * (1 + pct / 100);
    const px = floorToTick(rawPx, info.tickSize);
    let qty = floorToStep(perLeg, info.stepSize);
    if (i === ladder.length - 1) {
      // last leg: include rounding remainder
      qty = floorToStep(Math.max(0, qtyTotal - perLeg * (ladder.length - 1)), info.stepSize);
    }

    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (info.minQty && qty < info.minQty) continue;
    if (info.minNotional && qty * px < info.minNotional) continue;

    const order = await placeOrder({ symbol: plan.symbol, side: 'SELL', quantity: qty, price: px, type: 'LIMIT' });
    const id = order && typeof order === 'object' && 'orderId' in order ? Number((order as { orderId?: unknown }).orderId) : 0;
    if (Number.isFinite(id) && id > 0) orderIds.push(id);
    placed += 1;
  }

  return { placed, orderIds, at: Date.now() };
};

export const unwindTick = async (): Promise<UnwindRunResult> => {
  if (!config.unwindEnabled) return { ok: true, summary: { assetsQueued: [], ordersPlaced: 0, skipped: {} } };
  if (config.tradeVenue !== 'spot') return { ok: true, summary: { assetsQueued: [], ordersPlaced: 0, skipped: {} } };

  if (!config.tradingEnabled) {
    return { ok: true, summary: { assetsQueued: [], ordersPlaced: 0, skipped: { _global: 'TRADING_ENABLED=false' } } };
  }

  const blocked = nowBlocked();
  if (blocked.blocked) {
    return { ok: true, summary: { assetsQueued: [], ordersPlaced: 0, skipped: { _global: blocked.reason } } };
  }

  // Only runs in NORMAL/CAUTION (not HALT).
  const gov = persisted.meta?.riskGovernor?.decision?.state ?? null;
  if (gov === 'HALT') {
    return { ok: true, summary: { assetsQueued: [], ordersPlaced: 0, skipped: { _global: 'Risk Governor HALT' } } };
  }

  const { plans, skipped } = await computeUnwantedAssets();
  const queued = plans.map((p) => p.asset);

  // Persist status for API/UI (best-effort).
  try {
    persistMeta(persisted, {
      unwind: {
        at: Date.now(),
        queuedAssets: queued,
        enabled: true,
      },
    } as unknown as Record<string, unknown>);
  } catch {
    // ignore
  }

  // Requote control: only refresh ladders every N minutes.
  const requoteMs = Math.max(1, config.unwindRequoteMinutes) * 60_000;
  const last = (persisted.meta as Record<string, unknown> | undefined)?.unwind as
    | { at?: number; lastPlacedAt?: number }
    | undefined;
  const lastPlacedAt = typeof last?.lastPlacedAt === 'number' ? last.lastPlacedAt : 0;
  const due = !lastPlacedAt || Date.now() - lastPlacedAt >= requoteMs;

  if (!due) {
    return { ok: true, summary: { assetsQueued: queued, ordersPlaced: 0, skipped } };
  }

  let ordersPlaced = 0;

  for (const plan of plans) {
    try {
      if (config.unwindMode === 'market') {
        // Explicit opt-in. Still conservative: no forced market sells by default.
        const snap = await get24hStats(plan.symbol);
        const price = snap.price;
        const symbols = await fetchTradableSymbols();
        const info = symbols.find((s) => s.symbol.toUpperCase() === plan.symbol.toUpperCase());
        if (!info) continue;
        const qty = floorToStep(plan.qty, info.stepSize);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        if (info.minQty && qty < info.minQty) continue;
        if (info.minNotional && qty * price < info.minNotional) continue;
        await placeOrder({ symbol: plan.symbol, side: 'SELL', quantity: qty, type: 'MARKET' });
        ordersPlaced += 1;
      } else {
        const res = await placeLadder(plan);
        ordersPlaced += res.placed;
      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), asset: plan.asset, symbol: plan.symbol }, 'Unwind placement failed');
      skipped[plan.asset] = `Placement failed: ${errorToString(error)}`;
    }
  }

  // Persist last action time for re-quote scheduling.
  try {
    persistMeta(persisted, {
      unwind: {
        at: Date.now(),
        queuedAssets: queued,
        enabled: true,
        lastPlacedAt: Date.now(),
        lastOrdersPlaced: ordersPlaced,
      },
    } as unknown as Record<string, unknown>);
  } catch {
    // ignore
  }

  return { ok: true, summary: { assetsQueued: queued, ordersPlaced, skipped } };
};