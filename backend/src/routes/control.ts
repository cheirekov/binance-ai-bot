import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { get24hStats, getBalances, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getPersistedState, persistMeta } from '../services/persistence.js';
import { Balance } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';

const persisted = getPersistedState();

const emergencyStopSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(200).optional(),
});

const panicSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  stopAutoTrade: z.boolean().optional().default(true),
});

type LiquidationAction =
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

const extractExecutedQty = (order: unknown): number | null => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  const raw = rec.executedQty ?? rec.origQty ?? rec.quantity;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const toMap = (balances: Balance[]) => new Map(balances.map((b) => [b.asset.toUpperCase(), b]));

export async function controlRoutes(fastify: FastifyInstance) {
  fastify.post('/bot/emergency-stop', async (request) => {
    const parseResult = emergencyStopSchema.safeParse(request.body);
    if (!parseResult.success) {
      return { error: parseResult.error.flatten() };
    }

    const now = Date.now();
    persistMeta(persisted, {
      emergencyStop: parseResult.data.enabled,
      emergencyStopAt: now,
      emergencyStopReason: parseResult.data.reason ?? (parseResult.data.enabled ? 'manual' : 'cleared'),
    });

    return { ok: true, enabled: parseResult.data.enabled, at: now };
  });

  fastify.post('/portfolio/panic-liquidate', async (request, reply) => {
    const parseResult = panicSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }

    const home = config.homeAsset?.toUpperCase();
    if (!home) {
      reply.status(500);
      return { error: 'HOME_ASSET is not configured' };
    }

    const now = Date.now();
    const dryRun = parseResult.data.dryRun || !config.tradingEnabled;

    if (parseResult.data.stopAutoTrade) {
      persistMeta(persisted, {
        emergencyStop: true,
        emergencyStopAt: now,
        emergencyStopReason: 'panic-liquidate',
      });
    }

    let balances: Balance[];
    try {
      balances = await getBalances();
    } catch (error) {
      reply.status(500);
      return { error: `Failed to fetch balances: ${errorToString(error)}` };
    }

    if (!balances.length) {
      reply.status(400);
      return { error: 'No balances returned. Check Binance API key permissions.' };
    }

    const symbols = await fetchTradableSymbols();
    const byAsset = toMap(balances);

    const actions: LiquidationAction[] = [];
    const targets = balances
      .filter((b) => b.asset.toUpperCase() !== home)
      .filter((b) => b.free > 0 || b.locked > 0)
      .sort((a, b) => a.asset.localeCompare(b.asset));

    for (const bal of targets) {
      const asset = bal.asset.toUpperCase();
      const free = bal.free ?? 0;
      const locked = bal.locked ?? 0;

      if (free <= 0) {
        actions.push({ asset, status: 'skipped', reason: `No free balance (locked=${locked})` });
        continue;
      }

      const pair = symbols.find(
        (s) =>
          s.status === 'TRADING' &&
          (s.permissions?.includes('SPOT') || s.isSpotTradingAllowed) &&
          s.baseAsset.toUpperCase() === asset &&
          s.quoteAsset.toUpperCase() === home,
      );

      if (!pair) {
        actions.push({ asset, status: 'skipped', reason: `No direct ${asset}${home} market` });
        continue;
      }

      const requestedQty = free;
      if (dryRun) {
        actions.push({ asset, symbol: pair.symbol, side: 'SELL', requestedQty, status: 'simulated' });
        continue;
      }

      try {
        const order = await placeOrder({ symbol: pair.symbol, side: 'SELL', quantity: requestedQty, type: 'MARKET' });
        const executedQty = extractExecutedQty(order) ?? undefined;
        actions.push({
          asset,
          symbol: pair.symbol,
          side: 'SELL',
          requestedQty,
          executedQty,
          orderId: (order as { orderId?: string | number } | undefined)?.orderId,
          status: 'placed',
        });
      } catch (error) {
        logger.warn({ err: errorToLogObject(error), asset, symbol: pair.symbol }, 'Panic liquidate failed');
        actions.push({
          asset,
          symbol: pair.symbol,
          status: 'error',
          reason: errorToString(error),
        });
      }
    }

    let refreshed: Balance[] | undefined = undefined;
    if (!dryRun) {
      try {
        refreshed = await getBalances();
      } catch (error) {
        logger.warn({ err: errorToLogObject(error) }, 'Failed to refresh balances after panic liquidate');
      }
    }

    // If we placed any orders, invalidate cached tickers for HOME conversions by touching a market call.
    // This avoids stale price when UI immediately refreshes after liquidation.
    if (actions.some((a) => a.status === 'placed')) {
      try {
        const ref = `${home}USDC`;
        void (await get24hStats(ref));
      } catch {
        // ignore
      }
    }

    const stillHeld = (refreshed ?? balances).filter((b) => b.asset.toUpperCase() !== home && (b.free > 0 || b.locked > 0));
    const skipped = actions.filter((a) => a.status === 'skipped').length;
    const errored = actions.filter((a) => a.status === 'error').length;
    const placed = actions.filter((a) => a.status === 'placed').length;

    return {
      ok: true,
      dryRun,
      homeAsset: home,
      emergencyStop: persisted.meta?.emergencyStop ?? false,
      summary: { placed, skipped, errored, stillHeld: stillHeld.length },
      actions,
      balances: refreshed ?? balances,
    };
  });
}

