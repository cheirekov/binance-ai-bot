import { FastifyInstance } from 'fastify';

import { getStrategyResponse } from '../services/strategyService.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    const state = getStrategyResponse();
    return {
      status: 'ok',
      strategyStatus: state.status,
      lastUpdated: state.lastUpdated,
    };
  });
}
