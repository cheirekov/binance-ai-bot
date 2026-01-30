import { get24hStats, getBalances, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getPersistedState } from './persistence.js';

const persisted = getPersistedState();

type SweepAction =
  | {
      asset: string;
      symbol: string;
      side: 'SELL';
      requestedQty: number;
      orderId?: string | number;
      executedQty?: number;
      status: 'placed' | 'simulated';
    }
  | {
      asset: string;
      status: 'skipped';
      reason: string;
    }
  | {
      asset: string;
      symbol?: string;
      status: 'error';
      reason: string;
    };

export type SweepUnusedOptions = {
  dryRun?: boolean;
  keepAllowedQuotes?: boolean;
  keepPositionAssets?: boolean;
  keepAssets?: string[];
};

type SymbolInfo = Awaited<ReturnType<typeof fetchTradableSymbols>>[number];

const extractExecutedQty = (order: unknown): number | null => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  const raw = rec.executedQty ?? rec.origQty ?? rec.quantity;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : null;
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

const protectSpotPositionAssets = (protectedAssets: Set<string>) => {
  for (const pos of Object.values(persisted.positions)) {
    if (!pos) continue;
    if ((pos.venue ?? 'spot') !== 'spot') continue;
    if (pos.baseAsset) protectedAssets.add(pos.baseAsset.toUpperCase());
    if (pos.quoteAsset) protectedAssets.add(pos.quoteAsset.toUpperCase());
    if (pos.homeAsset) protectedAssets.add(pos.homeAsset.toUpperCase());
  }
};

const protectGridAssets = (protectedAssets: Set<string>) => {
  for (const grid of Object.values(persisted.grids ?? {})) {
    if (!grid || grid.status !== 'running') continue;
    if (grid.baseAsset) protectedAssets.add(grid.baseAsset.toUpperCase());
    if (grid.quoteAsset) protectedAssets.add(grid.quoteAsset.toUpperCase());
    if (grid.homeAsset) protectedAssets.add(grid.homeAsset.toUpperCase());
  }
};

const findDirectPair = (symbols: SymbolInfo[], baseAsset: string, quoteAsset: string) =>
  symbols.find(
    (s) =>
      s.status === 'TRADING' &&
      (s.permissions?.includes('SPOT') || s.isSpotTradingAllowed) &&
      s.baseAsset.toUpperCase() === baseAsset.toUpperCase() &&
      s.quoteAsset.toUpperCase() === quoteAsset.toUpperCase(),
  );

export const sweepUnusedToHome = async (options: SweepUnusedOptions) => {
  if (config.tradeVenue !== 'spot') {
    return { ok: false as const, error: 'Sweep-unused is only available in spot mode (TRADE_VENUE=spot).' };
  }

  const home = config.homeAsset?.toUpperCase();
  if (!home) return { ok: false as const, error: 'HOME_ASSET is not configured' };

  const dryRun = !!options.dryRun || !config.tradingEnabled;

  let balances: Balance[];
  try {
    balances = await getBalances();
  } catch (error) {
    return { ok: false as const, error: `Failed to fetch balances: ${errorToString(error)}` };
  }
  if (!balances.length) {
    return { ok: false as const, error: 'No balances returned. Check Binance API key permissions.' };
  }

  const protectedAssets = new Set<string>([home]);
  if (options.keepAllowedQuotes ?? true) {
    for (const asset of config.quoteAssets) protectedAssets.add(asset.toUpperCase());
    protectedAssets.add(config.quoteAsset.toUpperCase());
  }
  for (const asset of options.keepAssets ?? []) protectedAssets.add(asset.toUpperCase());
  if (options.keepPositionAssets ?? true) protectSpotPositionAssets(protectedAssets);
  protectGridAssets(protectedAssets);

  const symbols = await fetchTradableSymbols();
  const actions: SweepAction[] = [];

  const targets = balances
    .filter((b) => !protectedAssets.has(b.asset.toUpperCase()))
    .filter((b) => (b.free ?? 0) > 0 || (b.locked ?? 0) > 0)
    .sort((a, b) => a.asset.localeCompare(b.asset));

  for (const bal of targets) {
    const asset = bal.asset.toUpperCase();
    const free = bal.free ?? 0;
    const locked = bal.locked ?? 0;

    if (free <= 0) {
      actions.push({ asset, status: 'skipped', reason: `No free balance (locked=${locked})` });
      continue;
    }

    const pair = findDirectPair(symbols, asset, home);
    if (!pair) {
      actions.push({ asset, status: 'skipped', reason: `No direct ${asset}${home} market` });
      continue;
    }

    const requestedQty = free;
    const adjustedQty = floorToStep(requestedQty, pair.stepSize);
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
      actions.push({ asset, status: 'skipped', reason: `Dust: qty ${requestedQty} rounds to 0 (stepSize=${pair.stepSize ?? 'n/a'})` });
      continue;
    }
    if (pair.minQty && adjustedQty < pair.minQty) {
      actions.push({ asset, status: 'skipped', reason: `Dust: qty ${adjustedQty} below minQty ${pair.minQty}` });
      continue;
    }
    if (pair.minNotional) {
      try {
        const snap = await get24hStats(pair.symbol);
        const notional = adjustedQty * snap.price;
        if (notional < pair.minNotional) {
          actions.push({ asset, status: 'skipped', reason: `Dust: notional ${notional.toFixed(8)} below minNotional ${pair.minNotional}` });
          continue;
        }
      } catch {
        // If pricing fails, let placeOrder validate; worst-case it becomes an 'error' action.
      }
    }

    if (dryRun) {
      actions.push({ asset, symbol: pair.symbol, side: 'SELL', requestedQty: adjustedQty, status: 'simulated' });
      continue;
    }

    try {
      const order = await placeOrder({ symbol: pair.symbol, side: 'SELL', quantity: adjustedQty, type: 'MARKET' });
      const executedQty = extractExecutedQty(order) ?? undefined;
      actions.push({
        asset,
        symbol: pair.symbol,
        side: 'SELL',
        requestedQty: adjustedQty,
        executedQty,
        orderId: (order as { orderId?: string | number } | undefined)?.orderId,
        status: 'placed',
      });
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), asset, symbol: pair.symbol }, 'Sweep unused failed');
      actions.push({ asset, symbol: pair.symbol, status: 'error', reason: errorToString(error) });
    }
  }

  let refreshed: Balance[] | undefined = undefined;
  if (!dryRun) {
    try {
      refreshed = await getBalances();
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Failed to refresh balances after sweep');
    }
  }

  // If we placed any orders, invalidate cached tickers for HOME conversions by touching a market call.
  if (actions.some((a) => a.status === 'placed')) {
    try {
      const ref = `${home}USDC`;
      void (await get24hStats(ref));
    } catch {
      // ignore
    }
  }

  const stillHeld = (refreshed ?? balances).filter(
    (b) => !protectedAssets.has(b.asset.toUpperCase()) && b.asset.toUpperCase() !== home && (b.free > 0 || b.locked > 0),
  );
  const skipped = actions.filter((a) => a.status === 'skipped').length;
  const errored = actions.filter((a) => a.status === 'error').length;
  const placed = actions.filter((a) => a.status === 'placed').length;

  return {
    ok: true as const,
    dryRun,
    homeAsset: home,
    protectedAssets: [...protectedAssets].sort(),
    summary: { placed, skipped, errored, stillHeld: stillHeld.length },
    actions,
    balances: refreshed ?? balances,
  };
};
