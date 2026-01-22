import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getKlines } from '../binance/client.js';
import { config, feeRate } from '../config.js';
import { buildStrategyBundle } from '../strategy/engine.js';
import { RiskSettings } from '../types.js';

const schema = z.object({
  symbol: z.string().optional(),
  interval: z.string().default('1h'),
  limit: z.number().int().min(50).max(500).default(200),
});

interface SimulationResult {
  hit: 'tp' | 'sl' | 'none';
  pnlPct: number;
  durationMs: number;
}

const simulatePlan = (
  klines: { high: number; low: number; close: number; openTime: number; closeTime: number }[],
  entryPrice: number,
  stopLoss: number,
  takeProfit: number[],
): SimulationResult => {
  const side = takeProfit[0] > entryPrice ? 'BUY' : 'SELL';

  for (const k of klines) {
    const candleHigh = k.high;
    const candleLow = k.low;

    const hitTp = side === 'BUY' ? candleHigh >= takeProfit[0] : candleLow <= takeProfit[0];
    const hitSl = side === 'BUY' ? candleLow <= stopLoss : candleHigh >= stopLoss;

    if (hitTp) {
      const pnl = side === 'BUY' ? (takeProfit[0] - entryPrice) / entryPrice : (entryPrice - takeProfit[0]) / entryPrice;
      return { hit: 'tp', pnlPct: pnl * 100 - feeRate.taker * 200, durationMs: k.closeTime - klines[0].openTime };
    }
    if (hitSl) {
      const pnl = side === 'BUY' ? (stopLoss - entryPrice) / entryPrice : (entryPrice - stopLoss) / entryPrice;
      return { hit: 'sl', pnlPct: pnl * 100 - feeRate.taker * 200, durationMs: k.closeTime - klines[0].openTime };
    }
  }
  const last = klines[klines.length - 1];
  const exitPrice = last.close;
  const pnl =
    side === 'BUY' ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
  return { hit: 'none', pnlPct: pnl * 100 - feeRate.taker * 200, durationMs: last.closeTime - klines[0].openTime };
};

export async function backtestRoutes(fastify: FastifyInstance) {
  fastify.post('/backtest', async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: parsed.error.flatten() };
    }
    const { symbol, interval, limit } = parsed.data;
    const targetSymbol = (symbol ?? config.defaultSymbol).toUpperCase();

    const klines = await getKlines(targetSymbol, interval, limit);
    if (klines.length < 10) {
      reply.status(400);
      return { error: 'Not enough klines for backtest' };
    }

    const first = klines[0];
    const snapshot = {
      symbol: targetSymbol,
      price: first.close,
      priceChangePercent: 0,
      highPrice: first.high,
      lowPrice: first.low,
      volume: first.volume,
      updatedAt: first.closeTime,
    };

    const risk: RiskSettings = {
      maxPositionSizeUsdt: config.maxPositionSizeUsdt,
      riskPerTradeFraction: config.riskPerTradeBasisPoints / 10000,
      feeRate,
    };

    const bundle = await buildStrategyBundle(snapshot, risk, 0, 1);
    const plan = bundle.short; // use short-term plan for backtest

    const sim = simulatePlan(
      klines.slice(1),
      plan.entries[0].priceTarget,
      plan.exitPlan.stopLoss,
      plan.exitPlan.takeProfit,
    );

    return {
      symbol: targetSymbol,
      interval,
      limit,
      plan,
      result: sim,
    };
  });
}
