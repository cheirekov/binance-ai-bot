import { FastifyInstance } from 'fastify';

import { getStrategyState } from '../services/strategyService.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    const state = getStrategyState();
    return {
      status: 'ok',
      strategyStatus: state.status,
      lastUpdated: state.lastUpdated,
    };
  });
}
