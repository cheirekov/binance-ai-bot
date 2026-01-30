import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';
import { autoTradeTick } from './autoTrader.js';
import { riskGovernorTick } from './riskGovernor.js';
import { refreshBestSymbol, refreshStrategies } from './strategyService.js';
import { tradeSyncTick } from './tradeSync.js';

let timer: NodeJS.Timeout | null = null;

const runOnce = async () => {
  try {
    let symbolToTrade: string | undefined = undefined;
    if (config.autoSelectSymbol) {
      const result = await refreshBestSymbol();
      symbolToTrade = result.bestSymbol;
    } else {
      await refreshStrategies(config.defaultSymbol);
      symbolToTrade = config.defaultSymbol;
    }
    // Risk Governor runs on live equity + indicators (no DB dependency). Best-effort: failures must not stop trading loop.
    await riskGovernorTick(symbolToTrade);
    await autoTradeTick(symbolToTrade);
    // Trade sync runs in the background (never blocks the trading tick).
    void tradeSyncTick();
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Scheduled refresh failed');
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
