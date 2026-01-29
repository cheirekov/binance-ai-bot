import { FastifyInstance } from 'fastify';

import { getDbHealth, getPerformanceStats } from '../services/sqlite.js';

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats/performance', async () => {
    return getPerformanceStats();
  });

  fastify.get('/stats/db', async () => {
    return getDbHealth();
  });
}
