import { FastifyInstance } from 'fastify';

import { getPerformanceStats } from '../services/sqlite.js';

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats/performance', async () => {
    return getPerformanceStats();
  });
}

