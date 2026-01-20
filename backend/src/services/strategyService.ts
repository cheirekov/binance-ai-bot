import { get24hStats, getBalances, getBookTicker } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { buildStrategyBundle } from '../strategy/engine.js';
import { Balance, RiskSettings, StrategyResponsePayload, StrategyState } from '../types.js';
import { getNewsSentiment } from './newsService.js';
import { loadState, persistStrategy } from './persistence.js';

const riskSettings: RiskSettings = {
  maxPositionSizeUsdt: config.maxPositionSizeUsdt,
  riskPerTradeFraction: config.riskPerTradeBasisPoints / 10000,
  feeRate,
};

const stateBySymbol: Record<string, StrategyState> = {};
const persisted = loadState();

const cacheBalances = async (): Promise<Balance[]> => {
  const balances = await getBalances();
  return balances;
};

export const normalizeSymbol = (symbol?: string) => {
  const normalized = (symbol ?? config.defaultSymbol).toUpperCase();
  if (!/^[A-Z0-9]{5,15}$/.test(normalized)) {
    throw new Error('Invalid symbol format');
  }
  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(normalized)) {
    throw new Error(`Symbol ${normalized} not allowed. Update ALLOWED_SYMBOLS to include it.`);
  }
  return normalized;
};

const ensureState = (symbol: string): StrategyState => {
  if (!stateBySymbol[symbol]) {
    const saved = persisted.strategies[symbol];
    if (saved) {
      stateBySymbol[symbol] = {
        market: saved.market ?? null,
        balances: saved.balances ?? [],
        strategies: saved.strategies ?? null,
        lastUpdated: saved.lastUpdated ?? null,
        status: saved.status ?? 'idle',
        riskFlags: saved.riskFlags ?? [],
        tradeHalted: saved.tradeHalted ?? false,
      };
    } else {
      stateBySymbol[symbol] = {
        market: null,
        balances: [],
        strategies: null,
        lastUpdated: null,
        status: 'idle',
        riskFlags: [],
        tradeHalted: false,
      };
    }
  }
  return stateBySymbol[symbol];
};

export const refreshStrategies = async (symbolInput?: string) => {
  const symbol = normalizeSymbol(symbolInput);
  const state = ensureState(symbol);
  state.status = 'refreshing';
  state.error = undefined;
  state.riskFlags = [];
  try {
    const news = await getNewsSentiment();
    const market = await get24hStats(symbol);
    state.market = market;

    const balances = await cacheBalances();
    state.balances = balances;
    const volatilityPct = Math.abs((market.highPrice - market.lowPrice) / market.price) * 100;
    const quoteVol = market.quoteVolume ?? 0;

    if (volatilityPct > config.maxVolatilityPercent) {
      state.riskFlags.push(`Volatility ${volatilityPct.toFixed(2)}% exceeds cap ${config.maxVolatilityPercent}%`);
    }
    if (quoteVol < config.minQuoteVolume) {
      state.riskFlags.push(
        `Quote volume ${quoteVol.toLocaleString()} below floor ${config.minQuoteVolume.toLocaleString()}`,
      );
    }

    state.tradeHalted = state.riskFlags.length > 0;

    state.strategies = await buildStrategyBundle(market, riskSettings, news.sentiment);
    state.lastUpdated = Date.now();
    state.status = 'ready';
    const snapshot = getStrategyResponse(symbol);
    persistStrategy(persisted, symbol, snapshot);
  } catch (error) {
    logger.error({ err: error }, 'Failed to refresh strategies');
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    throw error;
  }
};

export const getStrategyResponse = (symbolInput?: string): StrategyResponsePayload => {
  const symbol = normalizeSymbol(symbolInput);
  const state = ensureState(symbol);
  return {
    status: state.status,
    symbol,
    market: state.market,
    balances: state.balances,
    strategies: state.strategies,
    risk: riskSettings,
    quoteAsset: config.quoteAsset,
    availableSymbols: config.allowedSymbols,
    lastUpdated: state.lastUpdated,
    error: state.error,
    riskFlags: state.riskFlags,
    tradeHalted: state.tradeHalted,
  };
};

export const getRiskSettings = () => riskSettings;

const scoreSnapshot = (snapshot: {
  priceChangePercent: number;
  quoteVolume?: number;
  highPrice: number;
  lowPrice: number;
  price: number;
  spreadPct?: number;
}) => {
  const momentumScore = Math.abs(snapshot.priceChangePercent);
  const liquidityScore = Math.log10(Math.max(snapshot.quoteVolume ?? 1, 1)) / 10; // dampen scale
  const volPct = Math.abs((snapshot.highPrice - snapshot.lowPrice) / snapshot.price) * 100;
  const volPenalty = volPct > config.maxVolatilityPercent ? -5 : 0;
  const spreadPenalty = snapshot.spreadPct && snapshot.spreadPct > 0.25 ? -2 : 0;
  return momentumScore + liquidityScore + volPenalty + spreadPenalty;
};

export const refreshBestSymbol = async () => {
  let symbols = config.allowedSymbols.length ? config.allowedSymbols : [config.defaultSymbol];

  if (config.autoDiscoverSymbols) {
    try {
      const exchangeSymbols = await fetchTradableSymbols();
      symbols = exchangeSymbols
        .filter(
          (s) =>
            s.status === 'TRADING' &&
            config.allowedQuoteAssets.includes(s.quoteAsset.toUpperCase()) &&
            !config.blacklistSymbols.includes(s.symbol.toUpperCase()),
        )
        .map((s) => s.symbol);
    } catch (error) {
      logger.warn({ err: error }, 'Auto-discover failed; falling back to configured symbols');
    }
  }

  const candidates: { symbol: string; score: number }[] = [];

  for (const symbol of symbols) {
    try {
      const snap = await get24hStats(symbol);
      let spreadPct: number | undefined;
      try {
        const book = await getBookTicker(symbol);
        const mid = (book.bid + book.ask) / 2;
        spreadPct = ((book.ask - book.bid) / mid) * 100;
      } catch (error) {
        logger.warn({ err: error, symbol }, 'Book ticker failed; skipping spread penalty');
      }
      const score = scoreSnapshot({ ...snap, spreadPct });
      candidates.push({ symbol, score });
    } catch (error) {
      logger.warn({ err: error, symbol }, 'Skipping symbol during auto-select');
    }
  }

  if (!candidates.length) {
    throw new Error('No symbols could be scored. Check ALLOWED_SYMBOLS or API connectivity.');
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  await refreshStrategies(best.symbol);
  return { bestSymbol: best.symbol, candidates };
};
