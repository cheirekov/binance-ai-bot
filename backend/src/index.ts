import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyBaseLogger } from 'fastify';

import { config } from './config.js';
import { logger } from './logger.js';
import { backtestRoutes } from './routes/backtest.js';
import { controlRoutes } from './routes/control.js';
import { healthRoutes } from './routes/health.js';
import { ordersRoutes } from './routes/orders.js';
import { strategyRoutes } from './routes/strategy.js';
import { startScheduler } from './services/scheduler.js';

const fastify = Fastify({
  // Casting keeps custom pino instance while satisfying Fastify types
  logger: logger as unknown as FastifyBaseLogger,
});

const bootstrap = async () => {
  await fastify.register(cors, {
    origin: config.frontendOrigin,
  });

  await fastify.register(rateLimit, {
    max: 30,
    timeWindow: '10 seconds',
  });

  fastify.addHook('preHandler', async (request, reply) => {
    if (!config.apiKey) return;
    const provided = request.headers['x-api-key'] as string | undefined;
    if (provided !== config.apiKey) {
      reply.code(401);
      throw new Error('Unauthorized');
    }
  });

  await fastify.register(healthRoutes);
  await fastify.register(backtestRoutes);
  await fastify.register(controlRoutes);
  await fastify.register(strategyRoutes);
  await fastify.register(ordersRoutes);

  startScheduler();

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`API server listening on ${config.port}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
};

void bootstrap();
