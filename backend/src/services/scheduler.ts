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
    // Always refresh universe/candidates so the bot keeps scanning the exchange, even when a symbol is pinned.
    // When AUTO_SELECT_SYMBOL=false, we do NOT switch activeSymbol; we only update rankedCandidates + debug.
    let best: string | undefined;
    try {
      const discovery = await refreshBestSymbol({
        setActiveSymbol: config.autoSelectSymbol,
        refreshBestSymbolStrategies: config.autoSelectSymbol,
      });
      best = discovery.bestSymbol;
    } catch (error) {
      // Best-effort: discovery failures must not block the trading tick.
      logger.warn({ err: errorToLogObject(error) }, 'Universe discovery tick failed');
    }

    const symbolToTrade = config.autoSelectSymbol ? (best ?? config.defaultSymbol) : config.defaultSymbol;

    // Ensure the traded symbol always has a fresh strategy bundle.
    if (!config.autoSelectSymbol) {
      await refreshStrategies(symbolToTrade);
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
