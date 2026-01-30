import { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { resolveAutonomy } from '../services/aiAutonomy.js';
import { getPersistedState } from '../services/persistence.js';
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

  fastify.get('/stats/ai_coach', async () => {
    const persisted = getPersistedState();
    const governorState = persisted.meta?.riskGovernor?.decision?.state ?? null;
    const capabilities = resolveAutonomy(
      config.aiAutonomyProfile,
      {
        aiPolicyAllowRiskRelaxation: config.aiPolicyAllowRiskRelaxation,
        aiPolicySweepAutoApply: config.aiPolicySweepAutoApply,
        autoBlacklistEnabled: config.autoBlacklistEnabled,
      },
      governorState,
    );
    return {
      enabled: config.aiCoachEnabled,
      intervalSeconds: config.aiCoachIntervalSeconds,
      minEquityUsd: config.aiCoachMinEquityUsd,
      profile: config.aiAutonomyProfile,
      capabilities,
      latest: persisted.meta?.latestCoach ?? null,
    };
  });
}
