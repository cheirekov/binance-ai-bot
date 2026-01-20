import { get24hStats, getBalances } from '../binance/client.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { buildStrategyBundle } from '../strategy/engine.js';
import { Balance, RiskSettings, StrategyState } from '../types.js';

const riskSettings: RiskSettings = {
  maxPositionSizeUsdt: config.maxPositionSizeUsdt,
  riskPerTradeFraction: config.riskPerTradeBasisPoints / 10000,
  feeRate,
};

const state: StrategyState = {
  market: null,
  balances: [],
  strategies: null,
  lastUpdated: null,
  status: 'idle',
};

const cacheBalances = async (): Promise<Balance[]> => {
  const balances = await getBalances();
  state.balances = balances;
  return balances;
};

export const refreshStrategies = async () => {
  state.status = 'refreshing';
  state.error = undefined;
  try {
    const market = await get24hStats(config.symbol);
    state.market = market;

    await cacheBalances();
    state.strategies = await buildStrategyBundle(market, riskSettings);
    state.lastUpdated = Date.now();
    state.status = 'ready';
  } catch (error) {
    logger.error({ err: error }, 'Failed to refresh strategies');
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    throw error;
  }
};

export const getStrategyState = () => state;
export const getRiskSettings = () => riskSettings;
