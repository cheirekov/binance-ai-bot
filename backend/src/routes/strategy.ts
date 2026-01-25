import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { placeOrder } from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { autoTradeTick } from '../services/autoTrader.js';
import { getStrategyResponse, normalizeSymbol, refreshBestSymbol, refreshStrategies } from '../services/strategyService.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';

const tradeSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  symbol: z.string().optional(),
});

const symbolQuerySchema = z.object({
  symbol: z.string().optional(),
});

export async function strategyRoutes(fastify: FastifyInstance) {
  fastify.get('/strategy', async (request, reply) => {
    const parseResult = symbolQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid symbol' };
    }
    const symbol = parseResult.data.symbol;
    const state = getStrategyResponse(symbol);
    if (state.status === 'idle' || !state.strategies) {
      void refreshStrategies(state.symbol).catch((error) => {
        logger.warn({ err: errorToLogObject(error), symbol: state.symbol }, 'Background refresh failed');
      });
      return getStrategyResponse(state.symbol);
    }
    return state;
  });

  fastify.post('/strategy/refresh', async (request, reply) => {
    const parseResult = symbolQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid symbol' };
    }
    const symbol = parseResult.data.symbol;
    const state = getStrategyResponse(symbol);
    void refreshStrategies(state.symbol).catch((error) => {
      logger.warn({ err: errorToLogObject(error), symbol: state.symbol }, 'Manual refresh failed');
    });
    return { ok: true, state: getStrategyResponse(state.symbol) };
  });

  fastify.post('/strategy/auto-select', async (request, reply) => {
    try {
      const result = await refreshBestSymbol();
      const state = getStrategyResponse(result.bestSymbol);
      await autoTradeTick(result.bestSymbol);
      return { ok: true, state, ranked: result.candidates };
    } catch (error) {
      logger.error({ err: errorToLogObject(error) }, 'Auto-select failed');
      reply.status(500);
      return { error: errorToString(error) };
    }
  });

  fastify.post('/trade/execute', async (request, reply) => {
    const parseResult = tradeSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }
    const payload = parseResult.data;
    let symbol: string;
    try {
      symbol = normalizeSymbol(payload.symbol);
    } catch (error) {
      reply.status(400);
      return { error: error instanceof Error ? error.message : 'Invalid symbol' };
    }
    const orderPayload = { ...payload, symbol };

    const state = getStrategyResponse(symbol);
    if (state.tradeHalted) {
      reply.status(403);
      return { error: 'Trading halted due to risk flags', riskFlags: state.riskFlags };
    }

    if (config.tradeVenue === 'futures' && !config.futuresEnabled) {
      return {
        simulated: true,
        note: 'Futures trading disabled. Enable with FUTURES_ENABLED=true.',
        requested: orderPayload,
      };
    }

    if (!config.tradingEnabled) {
      return {
        simulated: true,
        note: 'Trading disabled. Enable with TRADING_ENABLED=true.',
        requested: orderPayload,
      };
    }

    try {
      const order = await placeOrder(orderPayload);
      return { ok: true, order };
    } catch (error) {
      logger.error({ err: errorToLogObject(error) }, 'Trade execution failed');
      reply.status(500);
      return { error: 'Trade failed', detail: errorToString(error) };
    }
  });
}
