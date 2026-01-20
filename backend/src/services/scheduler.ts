import { config } from '../config.js';
import { logger } from '../logger.js';
import { autoTradeTick } from './autoTrader.js';
import { refreshBestSymbol, refreshStrategies } from './strategyService.js';

let timer: NodeJS.Timeout | null = null;

const runOnce = async () => {
  try {
    if (config.autoSelectSymbol) {
      await refreshBestSymbol();
    } else {
      await refreshStrategies(config.defaultSymbol);
    }
    await autoTradeTick();
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
