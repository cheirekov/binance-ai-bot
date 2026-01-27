import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const listFromEnvUpper = (value: string | undefined, fallback: string[]): string[] => {
  if (value === undefined) return fallback;
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
};

const listFromEnvRaw = (value: string | undefined, fallback: string[]): string[] => {
  if (value === undefined) return fallback;
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const boolFromEnv = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
};

const tradeVenueFromEnv = (value: string | undefined): 'spot' | 'futures' => {
  const v = (value ?? 'spot').toLowerCase();
  return v === 'futures' ? 'futures' : 'spot';
};

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (!value) return fallback;
  const upper = value.toUpperCase();
  return (allowed.find((v) => v.toUpperCase() === upper) as T | undefined) ?? fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: numberFromEnv(process.env.PORT, 8788),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173',
  binanceApiKey: process.env.BINANCE_API_KEY ?? '',
  binanceApiSecret: process.env.BINANCE_API_SECRET ?? '',
  binanceBaseUrl: process.env.BINANCE_BASE_URL ?? 'https://api.binance.com',
  tradeVenue: tradeVenueFromEnv(process.env.TRADE_VENUE),
  futuresEnabled: boolFromEnv(process.env.FUTURES_ENABLED, false),
  futuresBaseUrl: process.env.FUTURES_BASE_URL ?? 'https://fapi.binance.com',
  futuresLeverage: Math.max(1, Math.min(125, numberFromEnv(process.env.FUTURES_LEVERAGE, 2))),
  futuresMarginType: ((process.env.FUTURES_MARGIN_TYPE ?? 'ISOLATED').toUpperCase() === 'CROSSED'
    ? 'CROSSED'
    : 'ISOLATED') as 'ISOLATED' | 'CROSSED',
  tradingEnabled: boolFromEnv(process.env.TRADING_ENABLED, false),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  openAiBaseUrl: process.env.OPENAI_BASE_URL ?? '',
  defaultSymbol: (process.env.SYMBOL ?? 'BTCEUR').toUpperCase(),
  quoteAsset: (process.env.QUOTE_ASSET ?? 'EUR').toUpperCase(),
  homeAsset: (process.env.HOME_ASSET ?? process.env.QUOTE_ASSET ?? 'EUR').toUpperCase(),
  allowedSymbols: listFromEnvUpper(process.env.ALLOWED_SYMBOLS, [
    'BTCEUR',
    'ETHEUR',
    'BTCUSDT',
    'ETHUSDT',
    'BTCUSDC',
    'ETHUSDC',
    'SOLUSDT',
    'BNBUSDT',
  ]),
  allowedQuoteAssets: listFromEnvUpper(process.env.ALLOWED_QUOTES, ['USDT', 'USDC', 'EUR']),
  universeMaxSymbols: numberFromEnv(process.env.UNIVERSE_MAX_SYMBOLS, 50),
  maxPositionSizeUsdt: numberFromEnv(process.env.MAX_POSITION_SIZE_USDT, 200),
  riskPerTradeBasisPoints: numberFromEnv(process.env.RISK_PER_TRADE_BP, 50),
  refreshSeconds: numberFromEnv(process.env.REFRESH_SECONDS, 30),
  autoSelectSymbol: boolFromEnv(process.env.AUTO_SELECT_SYMBOL, false),
  autoDiscoverSymbols: boolFromEnv(process.env.AUTO_DISCOVER_SYMBOLS, true),
  minQuoteVolume: numberFromEnv(process.env.MIN_QUOTE_VOLUME, 5_000_000),
  maxVolatilityPercent: numberFromEnv(process.env.MAX_VOLATILITY_PCT, 18),
  newsFeeds: listFromEnvRaw(
    process.env.NEWS_FEEDS,
    ['https://rss.app/feeds/tJm8nlqwIBwQnS5s.xml', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ),
  newsCacheMinutes: numberFromEnv(process.env.NEWS_CACHE_MINUTES, 15),
  newsWeight: numberFromEnv(process.env.NEWS_WEIGHT, 2),
  blacklistSymbols: listFromEnvUpper(process.env.BLACKLIST_SYMBOLS, []),
  persistencePath: process.env.PERSISTENCE_PATH ?? './data/state.json',
  autoTradeEnabled: boolFromEnv(process.env.AUTO_TRADE_ENABLED, false),
  autoTradeHorizon: (process.env.AUTO_TRADE_HORIZON ?? 'short').toLowerCase() as 'short' | 'medium' | 'long',
  autoTradeMinConfidence: numberFromEnv(process.env.AUTO_TRADE_MIN_CONFIDENCE, 55) / 100,
  autoTradeCooldownMinutes: numberFromEnv(process.env.AUTO_TRADE_COOLDOWN_MINUTES, 90),
  dailyLossCapPct: numberFromEnv(process.env.DAILY_LOSS_CAP_PCT, 3),
  slippageBps: numberFromEnv(process.env.SLIPPAGE_BPS, 8),
  ocoEnabled: boolFromEnv(process.env.OCO_ENABLED, true) && tradeVenueFromEnv(process.env.TRADE_VENUE) !== 'futures',
  portfolioEnabled: boolFromEnv(process.env.PORTFOLIO_ENABLED, false),
  portfolioMaxAllocPct: numberFromEnv(process.env.PORTFOLIO_MAX_ALLOC_PCT, 50),
  portfolioMaxPositions: numberFromEnv(process.env.PORTFOLIO_MAX_POSITIONS, 3),
  conversionEnabled: boolFromEnv(process.env.CONVERSION_ENABLED, false) && tradeVenueFromEnv(process.env.TRADE_VENUE) !== 'futures',
  riskOffSentiment: numberFromEnv(process.env.RISK_OFF_SENTIMENT, -0.5),
  gridEnabled: boolFromEnv(process.env.GRID_ENABLED, false) && tradeVenueFromEnv(process.env.TRADE_VENUE) === 'spot',
  gridAutoDiscover: boolFromEnv(process.env.GRID_AUTO_DISCOVER, true),
  gridSymbols: listFromEnvUpper(process.env.GRID_SYMBOLS, []),
  gridMaxAllocPct: numberFromEnv(process.env.GRID_MAX_ALLOC_PCT, 25),
  gridMaxActiveGrids: numberFromEnv(process.env.GRID_MAX_ACTIVE_GRIDS, 1),
  gridLevels: numberFromEnv(process.env.GRID_LEVELS, 21),
  gridKlineInterval: process.env.GRID_KLINE_INTERVAL ?? '1h',
  gridKlineLimit: numberFromEnv(process.env.GRID_KLINE_LIMIT, 120),
  gridMinRangePct: numberFromEnv(process.env.GRID_MIN_RANGE_PCT, 3),
  gridMaxRangePct: numberFromEnv(process.env.GRID_MAX_RANGE_PCT, 15),
  gridMaxTrendRatio: numberFromEnv(process.env.GRID_MAX_TREND_RATIO, 0.35),
  gridGapBps: numberFromEnv(process.env.GRID_GAP_BPS, 10),
  gridMinStepPct: numberFromEnv(process.env.GRID_MIN_STEP_PCT, 0.6),
  gridRebalanceSeconds: numberFromEnv(process.env.GRID_REBALANCE_SECONDS, 60),
  gridMaxNewOrdersPerTick: numberFromEnv(process.env.GRID_MAX_NEW_ORDERS_PER_TICK, 8),
  gridBootstrapBasePct: numberFromEnv(process.env.GRID_BOOTSTRAP_BASE_PCT, 50),
  gridBreakoutAction: oneOf(process.env.GRID_BREAKOUT_ACTION, ['none', 'cancel', 'cancel_and_liquidate'] as const, 'cancel'),
  gridBreakoutBufferPct: numberFromEnv(process.env.GRID_BREAKOUT_BUFFER_PCT, 0.5),
  aiPolicyMode: oneOf(process.env.AI_POLICY_MODE, ['off', 'advisory', 'gated-live'] as const, 'off'),
  aiPolicyModel: process.env.AI_POLICY_MODEL ?? (process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'),
  aiPolicyMinIntervalSeconds: numberFromEnv(process.env.AI_POLICY_MIN_INTERVAL_SECONDS, 300),
  aiPolicyMaxCallsPerDay: numberFromEnv(process.env.AI_POLICY_MAX_CALLS_PER_DAY, 200),
  aiPolicyMaxCandidates: numberFromEnv(process.env.AI_POLICY_MAX_CANDIDATES, 8),
  apiKey: process.env.API_KEY ?? '',
  clientKey: process.env.CLIENT_KEY ?? '',
};

export const feeRate = {
  maker: 0.001,
  taker: 0.001,
};
