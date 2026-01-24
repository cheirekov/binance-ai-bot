import { get24hStats, getBalances } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { buildStrategyBundle } from '../strategy/engine.js';
import { Balance, RiskSettings, StrategyResponsePayload, StrategyState } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistMeta, persistStrategy } from './persistence.js';

const riskSettings: RiskSettings = {
  maxPositionSizeUsdt: config.maxPositionSizeUsdt,
  riskPerTradeFraction: config.riskPerTradeBasisPoints / 10000,
  feeRate,
};

const stateBySymbol: Record<string, StrategyState> = {};
const persisted = getPersistedState();
const quoteUsdCache: Record<string, number> = {};
let cachedBalances: { fetchedAt: number; balances: Balance[] } | null = null;
let activeSymbol =
  (config.allowedSymbols.length > 0 ? config.defaultSymbol : persisted.meta?.activeSymbol?.toUpperCase()) ||
  config.defaultSymbol;
let lastCandidates: { symbol: string; score: number }[] = persisted.meta?.rankedCandidates ?? [];
let lastAutoSelectAt: number | null = persisted.meta?.autoSelectUpdatedAt ?? null;

const stableLikeAssets = new Set([
  'USD',
  'EUR',
  'GBP',
  'USDT',
  'USDC',
  'BUSD',
  'TUSD',
  'FDUSD',
  'DAI',
  'USDP',
  'USDD',
]);

const isStableLikeAsset = (asset: string) => {
  const upper = asset.toUpperCase();
  if (stableLikeAssets.has(upper)) return true;
  // Common stablecoin tickers (USD1, USDP, USDD, etc.)
  if (upper.startsWith('USD') && upper.length <= 4) return true;
  return false;
};

const isStableToStablePair = (baseAsset: string, quoteAsset: string) =>
  isStableLikeAsset(baseAsset) && isStableLikeAsset(quoteAsset);

const accountBlacklistSet = () =>
  new Set(Object.keys(persisted.meta?.accountBlacklist ?? {}).map((s) => s.toUpperCase()));

const ensureActiveSymbolAllowed = () => {
  const blocked = accountBlacklistSet();
  const activeUpper = activeSymbol.toUpperCase();
  if (blocked.has(activeUpper)) {
    const fallback = [config.defaultSymbol.toUpperCase()].find((s) => !blocked.has(s));
    if (fallback) {
      activeSymbol = fallback;
      persistMeta(persisted, { activeSymbol });
    }
  }
};

const cacheBalances = async (): Promise<Balance[]> => {
  const now = Date.now();
  if (cachedBalances && now - cachedBalances.fetchedAt < 30_000) {
    return cachedBalances.balances;
  }
  const balances = await getBalances();
  cachedBalances = { fetchedAt: now, balances };
  return balances;
};

export const normalizeSymbol = (symbol?: string) => {
  const normalized = (symbol ?? config.defaultSymbol).toUpperCase();
  if (!/^[A-Z0-9]{5,15}$/.test(normalized)) {
    throw new Error('Invalid symbol format');
  }
  // Allowed list acts as a block list only when non-empty and symbol not discovered
  if (
    config.allowedSymbols.length > 0 &&
    !config.allowedSymbols.includes(normalized) &&
    !stateBySymbol[normalized]
  ) {
    throw new Error(`Symbol ${normalized} not allowed. Update ALLOWED_SYMBOLS to include it.`);
  }
  return normalized;
};

const deriveQuoteAsset = (symbol: string): string => {
  const candidates = [...config.allowedQuoteAssets, 'BTC', 'BNB', 'ETH'];
  const match = candidates.find((q) => symbol.endsWith(q));
  if (match) return match;
  // fallback: last 3 characters
  return symbol.slice(-3);
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

export const refreshStrategies = async (symbolInput?: string, options?: { useAi?: boolean }) => {
  const symbol = normalizeSymbol(symbolInput);
  const state = ensureState(symbol);
  state.status = 'refreshing';
  state.error = undefined;
  state.riskFlags = [];
  try {
    const news = await getNewsSentiment();
    const market = await get24hStats(symbol);
    market.quoteAsset = deriveQuoteAsset(symbol);
    // compute quote USD conversion for BTC/ETH/BNB
    if (market.quoteAsset && ['BTC', 'ETH', 'BNB'].includes(market.quoteAsset)) {
      const key = market.quoteAsset;
      if (!quoteUsdCache[key] || Date.now() - (quoteUsdCache as unknown as Record<string, number>)[`${key}_ts`] > 60_000) {
        const refSymbol = `${key}USDC`;
        try {
          const ref = await get24hStats(refSymbol);
          quoteUsdCache[key] = ref.price;
          (quoteUsdCache as unknown as Record<string, number>)[`${key}_ts`] = Date.now();
        } catch {
          quoteUsdCache[key] = 1;
          (quoteUsdCache as unknown as Record<string, number>)[`${key}_ts`] = Date.now();
        }
      }
    }
    state.market = market;

    const balances = await cacheBalances();
    state.balances = balances;
    const volatilityPct = Math.abs((market.highPrice - market.lowPrice) / market.price) * 100;
    const quoteVol = market.quoteVolume ?? 0;
    const quoteAsset = market.quoteAsset ?? config.quoteAsset;

    if (volatilityPct > config.maxVolatilityPercent) {
      state.riskFlags.push(`Volatility ${volatilityPct.toFixed(2)}% exceeds cap ${config.maxVolatilityPercent}%`);
    }
    const stableQuotes = ['USDT', 'USDC', 'USD', 'EUR', 'BUSD'];
    if (stableQuotes.includes(quoteAsset)) {
      if (quoteVol < config.minQuoteVolume) {
        state.riskFlags.push(
          `Quote volume ${quoteVol.toLocaleString()} below floor ${config.minQuoteVolume.toLocaleString()}`,
        );
      }
    }

    state.tradeHalted = state.riskFlags.length > 0;

    const quoteUsd = market.quoteAsset && quoteUsdCache[market.quoteAsset] ? quoteUsdCache[market.quoteAsset] : 1;
    state.strategies = await buildStrategyBundle(market, riskSettings, news.sentiment, quoteUsd, options);
    state.lastUpdated = Date.now();
    state.status = 'ready';
    const snapshot = getStrategyResponse(symbol);
    persistStrategy(persisted, symbol, snapshot);
  } catch (error) {
    logger.error({ err: errorToLogObject(error), symbol }, 'Failed to refresh strategies');
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    throw error;
  }
};

export const getStrategyResponse = (symbolInput?: string): StrategyResponsePayload => {
  let symbol: string;
  ensureActiveSymbolAllowed();
  try {
    symbol = normalizeSymbol(symbolInput ?? activeSymbol);
  } catch {
    symbol = normalizeSymbol();
  }
  const blocked = accountBlacklistSet();
  if (symbolInput && blocked.has(symbol.toUpperCase())) {
    // If a user selects a blacklisted symbol in the UI (e.g., stored in localStorage),
    // transparently return the active/default symbol instead.
    const fallback = [activeSymbol, config.defaultSymbol]
      .map((s) => s.toUpperCase())
      .find((s) => !blocked.has(s));
    if (fallback) {
      symbol = normalizeSymbol(fallback);
    }
  }
  const state = ensureState(symbol);
  const universeSymbols =
    config.allowedSymbols.length > 0
      ? config.allowedSymbols
      : lastCandidates.length > 0
        ? lastCandidates.map((c) => c.symbol)
        : Object.keys(stateBySymbol);
  const availableSymbols = universeSymbols.filter((s) => !blocked.has(s.toUpperCase()));
  const rankedCandidates = lastCandidates.filter((c) => !blocked.has(c.symbol.toUpperCase()));
  return {
    status: state.status,
    symbol,
    market: state.market,
    balances: state.balances,
    strategies: state.strategies,
    risk: riskSettings,
    quoteAsset: config.quoteAsset,
    emergencyStop: persisted.meta?.emergencyStop ?? false,
    emergencyStopAt: persisted.meta?.emergencyStopAt,
    emergencyStopReason: persisted.meta?.emergencyStopReason,
    availableSymbols,
    tradingEnabled: config.tradingEnabled,
    autoTradeEnabled: config.autoTradeEnabled,
    homeAsset: config.homeAsset,
    portfolioEnabled: config.portfolioEnabled,
    portfolioMaxAllocPct: config.portfolioMaxAllocPct,
    portfolioMaxPositions: config.portfolioMaxPositions,
    conversionEnabled: config.conversionEnabled,
    activeSymbol,
    autoSelectUpdatedAt: lastAutoSelectAt,
    rankedCandidates: rankedCandidates.slice(0, 25),
    lastAutoTrade: persisted.meta?.lastAutoTrade,
    positions: persisted.positions,
    equity: persisted.meta?.equity,
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

const looksLeverageToken = (symbol: string) => /(UP|DOWN|BULL|BEAR)$/.test(symbol);

export const refreshBestSymbol = async () => {
  const baseSymbols = config.allowedSymbols.length ? config.allowedSymbols : [config.defaultSymbol];
  let symbols = [...baseSymbols];
  let discovered: { symbol: string; quoteAsset: string; baseAsset: string }[] = [];

  // If the user provided an explicit allow-list, treat it as the universe for auto-select.
  // Auto-discovery is only used to validate/filter tradable SPOT symbols, not to expand the list.
  if (config.autoDiscoverSymbols && config.allowedSymbols.length === 0) {
    try {
      const exchangeSymbols = await fetchTradableSymbols();
      discovered = exchangeSymbols
        .filter(
          (s) =>
            s.status === 'TRADING' &&
            (s.permissions?.includes('SPOT') || s.isSpotTradingAllowed) &&
            config.allowedQuoteAssets.includes(s.quoteAsset.toUpperCase()) &&
            !config.blacklistSymbols.includes(s.symbol.toUpperCase()) &&
            !isStableToStablePair(s.baseAsset, s.quoteAsset) &&
            !looksLeverageToken(s.symbol),
        )
        .map((s) => ({
          symbol: s.symbol.toUpperCase(),
          quoteAsset: s.quoteAsset.toUpperCase(),
          baseAsset: s.baseAsset.toUpperCase(),
        }));
      symbols = discovered.map((s) => s.symbol);
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Auto-discover failed; falling back to configured symbols');
    }
  } else if (config.autoDiscoverSymbols && config.allowedSymbols.length > 0) {
    try {
      const exchangeSymbols = await fetchTradableSymbols();
      const infoBySymbol = new Map(exchangeSymbols.map((s) => [s.symbol.toUpperCase(), s]));
      const tradable = new Set(
        exchangeSymbols
          .filter(
            (s) =>
              s.status === 'TRADING' &&
              (s.permissions?.includes('SPOT') || s.isSpotTradingAllowed) &&
              !config.blacklistSymbols.includes(s.symbol.toUpperCase()) &&
              !looksLeverageToken(s.symbol),
          )
          .map((s) => s.symbol.toUpperCase()),
      );
      symbols = baseSymbols
        .map((s) => s.toUpperCase())
        .filter((s) => tradable.has(s))
        .filter((s) => {
          const info = infoBySymbol.get(s);
          if (!info) return true;
          return !isStableToStablePair(info.baseAsset, info.quoteAsset);
        });
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Auto-discover validation failed; using configured symbols as-is');
    }
  }

  // fallback if discovery returned nothing
  if (!symbols.length) {
    symbols = baseSymbols;
  }

  const blocked = accountBlacklistSet();
  if (blocked.size > 0) {
    symbols = symbols.filter((s) => !blocked.has(s.toUpperCase()));
    discovered = discovered.filter((s) => !blocked.has(s.symbol.toUpperCase()));
  }

  // keep it bounded, but pick by liquidity within each quote asset when auto-discovering
  if (config.allowedSymbols.length === 0 && discovered.length > 0) {
    const quoteVolumeBySymbol = new Map<string, number>();
    for (const item of discovered) {
      try {
        const snap = await get24hStats(item.symbol);
        quoteVolumeBySymbol.set(item.symbol, snap.quoteVolume ?? 0);
      } catch {
        quoteVolumeBySymbol.set(item.symbol, 0);
      }
    }

    const byQuote = new Map<string, string[]>();
    for (const item of discovered) {
      const list = byQuote.get(item.quoteAsset) ?? [];
      list.push(item.symbol);
      byQuote.set(item.quoteAsset, list);
    }

    const perQuoteLimit = Math.max(1, Math.floor(config.universeMaxSymbols / Math.max(byQuote.size, 1)));
    const selected: string[] = [];
    for (const symbolsForQuote of byQuote.values()) {
      const sorted = [...symbolsForQuote].sort(
        (a, b) => (quoteVolumeBySymbol.get(b) ?? 0) - (quoteVolumeBySymbol.get(a) ?? 0),
      );
      selected.push(...sorted.slice(0, perQuoteLimit));
    }

    const unique = new Set<string>([...selected, config.defaultSymbol.toUpperCase(), activeSymbol]);
    symbols = [...unique].slice(0, config.universeMaxSymbols);
  } else {
    symbols = symbols.slice(0, config.universeMaxSymbols);
  }

  const candidates: { symbol: string; score: number }[] = [];

  // Fetch balances once to make the selection wallet-aware without extra API calls.
  let balances: Balance[] = [];
  try {
    balances = await cacheBalances();
  } catch {
    balances = [];
  }
  const balanceFreeByAsset = new Map(balances.map((b) => [b.asset.toUpperCase(), b.free]));
  const hasFree = (asset: string) => (balanceFreeByAsset.get(asset.toUpperCase()) ?? 0) > 0;

  for (const symbol of symbols) {
    try {
      const snap = await get24hStats(symbol);
      const quoteAsset = deriveQuoteAsset(symbol).toUpperCase();
      const baseAsset = symbol.slice(0, Math.max(0, symbol.length - quoteAsset.length)).toUpperCase();
      const intendedSide =
        snap.priceChangePercent > 2
          ? 'BUY'
          : snap.priceChangePercent < -2
            ? 'SELL'
            : snap.priceChangePercent >= 0
              ? 'BUY'
              : 'SELL';

      // Skip symbols that we can't act on with current wallet (e.g., BUY requires quote balance).
      if (intendedSide === 'BUY' && balances.length > 0 && !hasFree(quoteAsset)) {
        continue;
      }
      if (intendedSide === 'SELL' && balances.length > 0 && !hasFree(baseAsset)) {
        continue;
      }

      const volPct = Math.abs((snap.highPrice - snap.lowPrice) / snap.price) * 100;
      const stableQuotes = ['USDT', 'USDC', 'USD', 'EUR', 'BUSD'];
      if (volPct > config.maxVolatilityPercent) continue;
      if (stableQuotes.includes(quoteAsset) && (snap.quoteVolume ?? 0) < config.minQuoteVolume) continue;

      const score = scoreSnapshot({ ...snap });
      candidates.push({ symbol, score });
    } catch (error: unknown) {
      const errObj = error as { code?: string; message?: string };
      logger.warn(
        { symbol, code: errObj?.code, msg: errObj?.message },
        'Skipping symbol during auto-select',
      );
    }
  }

  if (!candidates.length) {
    throw new Error('No symbols could be scored. Check ALLOWED_SYMBOLS or API connectivity.');
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  activeSymbol = best.symbol.toUpperCase();
  lastCandidates = candidates;
  lastAutoSelectAt = Date.now();
  persistMeta(persisted, {
    activeSymbol,
    rankedCandidates: lastCandidates.slice(0, 200),
    autoSelectUpdatedAt: lastAutoSelectAt,
  });
  await refreshStrategies(best.symbol, { useAi: true });
  return { bestSymbol: best.symbol, candidates };
};
