import { get24hStats, getBalances, getLatestPrice } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { buildStrategyBundle } from '../strategy/engine.js';
import { Balance, RiskSettings, StrategyResponsePayload, StrategyState } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { resolveAutonomy } from './aiAutonomy.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistMeta, persistStrategy } from './persistence.js';
import { getSymbolBlockInfo, pruneExpiredAutoBlacklist } from './symbolPolicy.js';

const currentRiskSettings = (): RiskSettings => ({
  maxPositionSizeUsdt: config.maxPositionSizeUsdt,
  riskPerTradeFraction: config.riskPerTradeBasisPoints / 10000,
  feeRate,
});

const stateBySymbol: Record<string, StrategyState> = {};
const persisted = getPersistedState();
const quoteToHomeCache: Record<string, { rate: number; fetchedAt: number }> = {};
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

const isVenueTradable = (s: Awaited<ReturnType<typeof fetchTradableSymbols>>[number]) => {
  if (config.tradeVenue === 'futures') {
    // USD-M futures exchangeInfo contains contractType; we only trade perpetual contracts.
    return s.status === 'TRADING' && (s.contractType ? s.contractType === 'PERPETUAL' : true);
  }
  return s.status === 'TRADING' && ((s.permissions?.includes('SPOT') ?? false) || s.isSpotTradingAllowed);
};

const ensureActiveSymbolAllowed = () => {
  const now = Date.now();
  pruneExpiredAutoBlacklist(now);
  const activeUpper = activeSymbol.toUpperCase();
  if (getSymbolBlockInfo(activeUpper, now).blocked) {
    const pool = [
      config.defaultSymbol,
      ...config.allowedSymbols,
      ...(persisted.meta?.rankedCandidates?.map((c) => c.symbol) ?? []),
    ]
      .map((s) => s.toUpperCase())
      .filter(Boolean);
    const fallback = pool.find((s) => !getSymbolBlockInfo(s, now).blocked);
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

const getQuoteToHomeRate = async (quoteAsset: string, homeAsset: string): Promise<number | null> => {
  const quote = quoteAsset.toUpperCase();
  const home = homeAsset.toUpperCase();
  if (!quote) return null;
  if (quote === home) return 1;

  const cacheKey = `${quote}_${home}`;
  const cached = quoteToHomeCache[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.rate;

  const directSymbol = `${quote}${home}`;
  try {
    const snap = await get24hStats(directSymbol);
    quoteToHomeCache[cacheKey] = { rate: snap.price, fetchedAt: Date.now() };
    return snap.price;
  } catch {
    // ignore
  }

  const inverseSymbol = `${home}${quote}`;
  try {
    const snap = await get24hStats(inverseSymbol);
    const rate = snap.price > 0 ? 1 / snap.price : null;
    if (rate) quoteToHomeCache[cacheKey] = { rate, fetchedAt: Date.now() };
    return rate;
  } catch {
    // ignore
  }

  // Fallback to spot conversion pairs (useful when running futures venue but HOME_ASSET is USDC/EUR).
  try {
    const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(directSymbol)}`);
    if (res.ok) {
      const data = (await res.json()) as { price?: string };
      const price = data?.price ? Number(data.price) : Number.NaN;
      if (Number.isFinite(price) && price > 0) {
        quoteToHomeCache[cacheKey] = { rate: price, fetchedAt: Date.now() };
        return price;
      }
    }
  } catch {
    // ignore
  }

  try {
    const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(inverseSymbol)}`);
    if (res.ok) {
      const data = (await res.json()) as { price?: string };
      const price = data?.price ? Number(data.price) : Number.NaN;
      if (Number.isFinite(price) && price > 0) {
        const rate = 1 / price;
        quoteToHomeCache[cacheKey] = { rate, fetchedAt: Date.now() };
        return rate;
      }
    }
  } catch {
    // ignore
  }

  return null;
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
    // Use the latest ticker price for strategy entry/exit calculations; keep 24h high/low/volume from the snapshot.
    try {
      const latest = await getLatestPrice(symbol);
      market.price = latest;
      market.updatedAt = Date.now();
    } catch {
      // keep cached 24h price if live ticker is temporarily unavailable
    }
    market.quoteAsset = deriveQuoteAsset(symbol);
    state.market = market;

    const balances = await cacheBalances();
    state.balances = balances;
    const volatilityPct = Math.abs((market.highPrice - market.lowPrice) / market.price) * 100;
    const quoteVol = market.quoteVolume ?? 0;
    const quoteAsset = market.quoteAsset ?? config.quoteAsset;
    const quoteToHome = await getQuoteToHomeRate(quoteAsset, config.homeAsset);
    const quoteVolHome = quoteToHome ? quoteVol * quoteToHome : null;

    if (volatilityPct > config.maxVolatilityPercent) {
      state.riskFlags.push(`Volatility ${volatilityPct.toFixed(2)}% exceeds cap ${config.maxVolatilityPercent}%`);
    }
    if (quoteVolHome !== null && quoteVolHome < config.minQuoteVolume) {
      state.riskFlags.push(
        `Quote volume ${quoteVolHome.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${config.homeAsset} below floor ${config.minQuoteVolume.toLocaleString()}`,
      );
    }

    state.tradeHalted = state.riskFlags.length > 0;

    let symbolRules:
      | {
          tickSize?: number;
          stepSize?: number;
          minQty?: number;
          minNotional?: number;
        }
      | undefined;
    try {
      const symbols = await fetchTradableSymbols();
      const info = symbols.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
      if (info) {
        symbolRules = {
          tickSize: info.tickSize,
          stepSize: info.stepSize,
          minQty: info.minQty,
          minNotional: info.minNotional,
        };
      }
    } catch {
      // ignore (best-effort; execution layer still enforces exchange rules)
    }

    state.strategies = await buildStrategyBundle(market, currentRiskSettings(), news.sentiment, quoteToHome ?? 1, {
      ...(options ?? {}),
      symbolRules,
    });
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
  const now = Date.now();
  pruneExpiredAutoBlacklist(now);
  const isBlocked = (s: string) => getSymbolBlockInfo(s, now).blocked;

  if (symbolInput && isBlocked(symbol.toUpperCase())) {
    // If a user selects a blacklisted symbol in the UI (e.g., stored in localStorage),
    // transparently return the active/default symbol instead.
    const fallback = [activeSymbol, config.defaultSymbol]
      .map((s) => s.toUpperCase())
      .find((s) => !isBlocked(s));
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
  const rankedCandidates = lastCandidates.filter((c) => !isBlocked(c.symbol.toUpperCase()));
  const rankedGridCandidates = (persisted.meta?.rankedGridCandidates ?? []).filter((c) => !isBlocked(c.symbol.toUpperCase()));
  const positionsForVenue = Object.fromEntries(
    Object.entries(persisted.positions).filter(([, p]) => (p?.venue ?? 'spot') === config.tradeVenue),
  );
  const runningGridSymbols = Object.keys(persisted.grids ?? {});
  const positionSymbols = Object.values(positionsForVenue)
    .map((p) => p?.symbol)
    .filter(Boolean) as string[];

  const symbolSet = new Set<string>();
  const addSymbol = (s?: string | null) => {
    const upper = (s ?? '').toUpperCase();
    if (!upper) return;
    symbolSet.add(upper);
  };

  addSymbol(activeSymbol);
  addSymbol(symbol);
  for (const s of universeSymbols) addSymbol(s);
  for (const s of runningGridSymbols) addSymbol(s);
  for (const s of positionSymbols) addSymbol(s);

  const availableSymbols = Array.from(symbolSet)
    .filter((s) => !isBlocked(s.toUpperCase()))
    .sort((a, b) => a.localeCompare(b));

  return {
    status: state.status,
    symbol,
    market: state.market,
    balances: state.balances,
    strategies: state.strategies,
    risk: currentRiskSettings(),
    quoteAsset: config.quoteAsset,
    minQuoteVolume: config.minQuoteVolume,
    maxVolatilityPercent: config.maxVolatilityPercent,
    autoTradeHorizon: config.autoTradeHorizon,
    tradeVenue: config.tradeVenue,
    futuresEnabled: config.futuresEnabled,
    futuresLeverage: config.futuresLeverage,
    emergencyStop: persisted.meta?.emergencyStop ?? false,
    emergencyStopAt: persisted.meta?.emergencyStopAt,
    emergencyStopReason: persisted.meta?.emergencyStopReason,
    availableSymbols,
    tradingEnabled: config.tradingEnabled,
    autoTradeEnabled: config.autoTradeEnabled,
    homeAsset: config.homeAsset,
    symbolPolicy: {
      whitelist: config.symbolWhitelist ?? [],
      envBlacklist: config.blacklistSymbols ?? [],
      accountBlacklist: Object.entries(persisted.meta?.accountBlacklist ?? {})
        .map(([symbol, row]) => ({ symbol: symbol.toUpperCase(), at: row.at ?? 0, reason: row.reason ?? 'account_blacklist' }))
        .filter((r) => r.symbol)
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      autoBlacklist: Object.entries(persisted.meta?.autoBlacklist ?? {})
        .map(([symbol, row]) => ({
          symbol: symbol.toUpperCase(),
          at: row.at ?? 0,
          bannedUntil: row.bannedUntil ?? 0,
          ttlMinutes: row.ttlMinutes ?? 0,
          reason: row.reason ?? 'auto_blacklist',
          source: row.source ?? undefined,
          triggers: row.triggers ?? undefined,
        }))
        .filter((r) => r.symbol && typeof r.bannedUntil === 'number' && r.bannedUntil > now)
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    },
    aiAutonomy: {
      profile: config.aiAutonomyProfile,
      capabilities: resolveAutonomy(
        config.aiAutonomyProfile,
        {
          aiPolicyAllowRiskRelaxation: config.aiPolicyAllowRiskRelaxation,
          aiPolicySweepAutoApply: config.aiPolicySweepAutoApply,
          autoBlacklistEnabled: config.autoBlacklistEnabled,
        },
        persisted.meta?.riskGovernor?.decision?.state ?? null,
      ),
    },
    aiCoach: {
      enabled: config.aiCoachEnabled,
      intervalSeconds: config.aiCoachIntervalSeconds,
      minEquityUsd: config.aiCoachMinEquityUsd,
      latest: persisted.meta?.latestCoach ?? null,
    },
    portfolioEnabled: config.portfolioEnabled,
    portfolioMaxAllocPct: config.portfolioMaxAllocPct,
    portfolioMaxPositions: config.portfolioMaxPositions,
    conversionEnabled: config.conversionEnabled,
    gridEnabled: config.gridEnabled,
    gridMaxAllocPct: config.gridMaxAllocPct,
    gridMaxActiveGrids: config.gridMaxActiveGrids,
    gridLevels: config.gridLevels,
    gridRebalanceSeconds: config.gridRebalanceSeconds,
    aiPolicyMode: config.aiPolicyMode,
    aiPolicy: persisted.meta?.aiPolicy,
    runtimeConfig: persisted.meta?.runtimeConfig,
    activeSymbol,
    autoSelectUpdatedAt: lastAutoSelectAt,
    rankedCandidates: rankedCandidates.slice(0, 25),
    rankedGridCandidates: rankedGridCandidates.slice(0, 25),
    gridUpdatedAt: persisted.meta?.gridUpdatedAt ?? null,
    lastAutoTrade: persisted.meta?.lastAutoTrade,
    positions: positionsForVenue,
    grids: persisted.grids ?? {},
    equity: persisted.meta?.equity,
    riskGovernor: persisted.meta?.riskGovernor?.decision ?? null,
    lastUpdated: state.lastUpdated,
    error: state.error,
    riskFlags: state.riskFlags,
    tradeHalted: state.tradeHalted,
  };
};

export const getRiskSettings = () => currentRiskSettings();

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
	            isVenueTradable(s) &&
	            config.allowedQuoteAssets.includes(s.quoteAsset.toUpperCase()) &&
	            !config.blacklistSymbols.includes(s.symbol.toUpperCase()) &&
	            (config.symbolWhitelist.length === 0 || config.symbolWhitelist.includes(s.symbol.toUpperCase())) &&
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
	              isVenueTradable(s) &&
	              !config.blacklistSymbols.includes(s.symbol.toUpperCase()) &&
	              (config.symbolWhitelist.length === 0 || config.symbolWhitelist.includes(s.symbol.toUpperCase())) &&
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

  const now = Date.now();
  pruneExpiredAutoBlacklist(now);
  const isBlocked = (s: string) => getSymbolBlockInfo(s, now).blocked;

  symbols = symbols.filter((s) => !isBlocked(s));
  discovered = discovered.filter((s) => !isBlocked(s.symbol));

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
    symbols = [...unique].filter((s) => !isBlocked(s)).slice(0, config.universeMaxSymbols);
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
  const homeAsset = config.homeAsset.toUpperCase();

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

      // Spot wallet-aware constraints: futures positions use shared margin and don't require holding base/quote.
      if (config.tradeVenue !== 'futures') {
        // Skip symbols that we can't act on with current wallet (e.g., BUY requires quote balance).
        if (intendedSide === 'BUY' && balances.length > 0 && !hasFree(quoteAsset)) {
          // Allow if we can convert from HOME_ASSET (conversion happens later during execution).
          if (!(config.conversionEnabled && hasFree(homeAsset))) continue;
        }
        if (intendedSide === 'SELL' && balances.length > 0 && !hasFree(baseAsset)) {
          continue;
        }
      }

      const volPct = Math.abs((snap.highPrice - snap.lowPrice) / snap.price) * 100;
      if (volPct > config.maxVolatilityPercent) continue;
      const quoteToHome = await getQuoteToHomeRate(quoteAsset, config.homeAsset);
      if (!quoteToHome) continue;
      const quoteVolHome = (snap.quoteVolume ?? 0) * quoteToHome;
      if (quoteVolHome < config.minQuoteVolume) continue;

      const score = scoreSnapshot({ ...snap, quoteVolume: quoteVolHome });
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
