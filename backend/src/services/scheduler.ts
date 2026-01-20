import { config } from '../config.js';
import { logger } from '../logger.js';
import { refreshStrategies } from './strategyService.js';

let timer: NodeJS.Timeout | null = null;

const runOnce = async () => {
  try {
    await refreshStrategies();
  } catch (error) {
    logger.warn({ err: error }, 'Scheduled refresh failed');
  }
};

export const startScheduler = () => {
  if (timer) return;
  void runOnce();
  timer = setInterval(runOnce, config.refreshSeconds * 1000);
  logger.info(
    { intervalSeconds: config.refreshSeconds },
    'Strategy refresh scheduler started',
  );
};

export const stopScheduler = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
