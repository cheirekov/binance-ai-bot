import { FastifyInstance } from 'fastify';

import { getDbHealth, getPerformanceStats, getPnlReconcile } from '../services/sqlite.js';

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats/performance', async () => {
    return getPerformanceStats();
  });

  fastify.get('/stats/pnl_reconcile', async (request) => {
    const query = request.query as Record<string, unknown>;
    const window = typeof query.window === 'string' ? query.window : undefined;
    return getPnlReconcile(window);
  });

  fastify.get('/stats/db', async () => {
    return getDbHealth();
  });
}
