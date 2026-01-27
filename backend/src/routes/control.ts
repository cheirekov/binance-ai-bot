import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { get24hStats, getBalances, getFuturesPositions, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { applyAiTuning } from '../services/aiTuning.js';
import { startGrid, stopGrid } from '../services/gridTrader.js';
import { getPersistedState, persistMeta } from '../services/persistence.js';
import { sweepUnusedToHome } from '../services/sweepUnused.js';
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

const sweepSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  stopAutoTrade: z.boolean().optional().default(false),
  keepAllowedQuotes: z.boolean().optional().default(true),
  keepPositionAssets: z.boolean().optional().default(true),
  keepAssets: z.array(z.string().min(1)).optional().default([]),
});

const gridSymbolSchema = z.object({
  symbol: z.string().min(5).max(20),
});

const aiTuningApplySchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

type LiquidationAction =
  | {
      asset: string;
      symbol: string;
      side: 'BUY' | 'SELL';
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

  fastify.post('/grid/start', async (request, reply) => {
    const parseResult = gridSymbolSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }
    const res = await startGrid(parseResult.data.symbol);
    if (!res.ok) reply.status(400);
    return res;
  });

  fastify.post('/grid/stop', async (request, reply) => {
    const parseResult = gridSymbolSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }
    const res = await stopGrid(parseResult.data.symbol);
    if (!res.ok) reply.status(400);
    return res;
  });

  fastify.post('/ai-policy/apply-tuning', async (request, reply) => {
    const parseResult = aiTuningApplySchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }

    const decision = persisted.meta?.aiPolicy?.lastDecision;
    const tune = decision?.tune;
    if (!decision || !tune || Object.keys(tune).length === 0) {
      reply.status(400);
      return { error: 'No AI tuning suggestion to apply.' };
    }

    const now = Date.now();
    if (parseResult.data.dryRun) {
      const res = applyAiTuning({ tune: { ...tune }, source: 'ai', reason: `ai-policy:${decision.action}`, dryRun: true });
      if (!res.ok) {
        reply.status(400);
        return { error: res.error };
      }
      return { ok: true, dryRun: true, at: now, wouldApply: res.wouldApply, notes: res.notes };
    }

    const res = applyAiTuning({ tune: { ...tune }, source: 'ai', reason: `ai-policy:${decision.action}` });
    if (!res.ok || !res.applied) {
      reply.status(400);
      return { error: res.ok ? 'AI tuning suggestion had no applicable changes.' : res.error };
    }
    return { ok: true, at: now, applied: res.applied, notes: res.notes };
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
    const dryRun =
      parseResult.data.dryRun ||
      !config.tradingEnabled ||
      (config.tradeVenue === 'futures' && !config.futuresEnabled);

    if (parseResult.data.stopAutoTrade) {
      persistMeta(persisted, {
        emergencyStop: true,
        emergencyStopAt: now,
        emergencyStopReason: 'panic-liquidate',
      });
    }

    if (config.tradeVenue === 'futures') {
      // Futures "panic": close all open positions with reduce-only market orders.
      const actions: LiquidationAction[] = [];
      const open = await getFuturesPositions();
      for (const pos of open) {
        const symbol = pos.symbol.toUpperCase();
        const qty = Math.abs(pos.positionAmt);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const side: 'BUY' | 'SELL' = pos.positionAmt > 0 ? 'SELL' : 'BUY';
        if (dryRun) {
          actions.push({ asset: symbol, symbol, side, requestedQty: qty, status: 'simulated' });
          continue;
        }
        try {
          const order = await placeOrder({ symbol, side, quantity: qty, type: 'MARKET', reduceOnly: true });
          const executedQty = extractExecutedQty(order) ?? undefined;
          actions.push({
            asset: symbol,
            symbol,
            side,
            requestedQty: qty,
            executedQty,
            orderId: (order as { orderId?: string | number } | undefined)?.orderId,
            status: 'placed',
          });
        } catch (error) {
          logger.warn({ err: errorToLogObject(error), symbol }, 'Futures panic close failed');
          actions.push({ asset: symbol, symbol, status: 'error', reason: errorToString(error) });
        }
      }

      const skipped = actions.filter((a) => a.status === 'skipped').length;
      const errored = actions.filter((a) => a.status === 'error').length;
      const placed = actions.filter((a) => a.status === 'placed').length;

      const balances = await getBalances();
      const stillHeld = dryRun ? open.length : (await getFuturesPositions()).length;
      return {
        ok: true,
        dryRun,
        homeAsset: home,
        emergencyStop: persisted.meta?.emergencyStop ?? false,
        summary: { placed, skipped, errored, stillHeld },
        actions,
        balances,
      };
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
      const adjustedQty = floorToStep(requestedQty, pair.stepSize);
      const minQty = pair.minQty ?? 0;
      if (!Number.isFinite(adjustedQty) || adjustedQty <= 0 || (minQty > 0 && adjustedQty < minQty)) {
        actions.push({
          asset,
          status: 'skipped',
          reason: `Dust: qty ${requestedQty} -> ${adjustedQty} below minQty ${minQty || 'unknown'}`,
        });
        continue;
      }

      const minNotional = pair.minNotional ?? 0;
      if (minNotional > 0) {
        try {
          const snap = await get24hStats(pair.symbol);
          const notional = adjustedQty * snap.price;
          if (notional < minNotional) {
            actions.push({
              asset,
              status: 'skipped',
              reason: `Dust: notional ${notional.toFixed(8)} below minNotional ${minNotional}`,
            });
            continue;
          }
        } catch {
          // If pricing fails, let placeOrder validate; worst-case it becomes an 'error' action.
        }
      }

      if (dryRun) {
        actions.push({ asset, symbol: pair.symbol, side: 'SELL', requestedQty, status: 'simulated' });
        continue;
      }

      try {
        const order = await placeOrder({ symbol: pair.symbol, side: 'SELL', quantity: adjustedQty, type: 'MARKET' });
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

  fastify.post('/portfolio/sweep-unused', async (request, reply) => {
    if (config.tradeVenue !== 'spot') {
      reply.status(400);
      return { error: 'Sweep-unused is only available in spot mode (TRADE_VENUE=spot).' };
    }

    const parseResult = sweepSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }

    const now = Date.now();

    if (parseResult.data.stopAutoTrade) {
      persistMeta(persisted, {
        emergencyStop: true,
        emergencyStopAt: now,
        emergencyStopReason: 'sweep-unused',
      });
    }

    const res = await sweepUnusedToHome({
      dryRun: parseResult.data.dryRun,
      keepAllowedQuotes: parseResult.data.keepAllowedQuotes,
      keepPositionAssets: parseResult.data.keepPositionAssets,
      keepAssets: parseResult.data.keepAssets,
    });
    if (!res.ok) {
      reply.status(500);
      return { error: res.error };
    }
    return { ...res, emergencyStop: persisted.meta?.emergencyStop ?? false };
  });
}
