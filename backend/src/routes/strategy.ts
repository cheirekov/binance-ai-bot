import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { placeOrder } from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getRiskSettings, getStrategyState, refreshStrategies } from '../services/strategyService.js';

const tradeSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
});

export async function strategyRoutes(fastify: FastifyInstance) {
  fastify.get('/strategy', async () => {
    const state = getStrategyState();
    return {
      status: state.status,
      market: state.market,
      balances: state.balances,
      strategies: state.strategies,
      risk: getRiskSettings(),
      lastUpdated: state.lastUpdated,
    };
  });

  fastify.post('/strategy/refresh', async () => {
    await refreshStrategies();
    const state = getStrategyState();
    return { ok: true, state };
  });

  fastify.post('/trade/execute', async (request, reply) => {
    const parseResult = tradeSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: parseResult.error.flatten() };
    }
    const payload = parseResult.data;
    const orderPayload = { ...payload, symbol: config.symbol };

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
      logger.error({ err: error }, 'Trade execution failed');
      reply.status(500);
      return { error: 'Trade failed', detail: error instanceof Error ? error.message : error };
    }
  });
}
