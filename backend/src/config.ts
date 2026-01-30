import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const cleaned = stripInlineComment(value);
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stripInlineComment = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return '';
  // Treat " ... # comment" as comment, but keep hashes inside tokens (e.g. URL fragments).
  const match = value.match(/(^|\s)#/);
  if (!match || match.index === undefined) return value;
  const idx = match.index + (match[1] ? match[1].length : 0);
  return value.slice(0, idx).trimEnd();
};

const stringFromEnv = (value: string | undefined, fallback: string): string => {
  const cleaned = stripInlineComment(value);
  if (cleaned === undefined) return fallback;
  const trimmed = cleaned.trim();
  return trimmed === '' ? fallback : trimmed;
};

const optionalStringFromEnv = (value: string | undefined, fallback = ''): string => {
  const cleaned = stripInlineComment(value);
  if (cleaned === undefined) return fallback;
  return cleaned.trim();
};

const listFromEnvUpper = (value: string | undefined, fallback: string[]): string[] => {
  const cleaned = stripInlineComment(value);
  if (cleaned === undefined) return fallback;
  if (cleaned.trim() === '') return [];
  return cleaned
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean)
    .filter((v) => /^[A-Z0-9]{2,30}$/.test(v));
};

const listFromEnvRaw = (value: string | undefined, fallback: string[]): string[] => {
  const cleaned = stripInlineComment(value);
  if (cleaned === undefined) return fallback;
  if (cleaned.trim() === '') return [];
  return cleaned
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => !v.startsWith('#'));
};

const boolFromEnv = (value: string | undefined, fallback = false): boolean => {
  const cleaned = stripInlineComment(value);
  if (cleaned === undefined) return fallback;
  return cleaned.trim().toLowerCase() === 'true';
};

const tradeVenueFromEnv = (value: string | undefined): 'spot' | 'futures' => {
  const v = (stripInlineComment(value) ?? 'spot').trim().toLowerCase();
  return v === 'futures' ? 'futures' : 'spot';
};

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  const cleaned = stripInlineComment(value);
  if (!cleaned) return fallback;
  const upper = cleaned.trim().toUpperCase();
  return (allowed.find((v) => v.toUpperCase() === upper) as T | undefined) ?? fallback;
};

export type RuntimeConfigOverrides = Partial<{
  minQuoteVolume: number;
  maxVolatilityPercent: number;
  riskPerTradeBasisPoints: number;
  autoTradeHorizon: 'short' | 'medium' | 'long';
  portfolioMaxAllocPct: number;
  portfolioMaxPositions: number;
  gridMaxAllocPct: number;
}>;

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const runtimeBounds = {
  minQuoteVolume: { min: 100_000, max: 200_000_000 },
  maxVolatilityPercent: { min: 2, max: 60 },
  riskPerTradeBasisPoints: { min: 1, max: 200 },
  portfolioMaxAllocPct: { min: 1, max: 95 },
  portfolioMaxPositions: { min: 1, max: 15 },
  gridMaxAllocPct: { min: 0, max: 80 },
} as const;

const parseRangeFromEnv = (
  value: string | undefined,
  fallback: { min: number; max: number },
  bounds: { min: number; max: number },
): { min: number; max: number } => {
  const cleaned = stripInlineComment(value);
  if (!cleaned) return fallback;
  const trimmed = cleaned.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*\.\.\s*(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;
  const minRaw = Number(match[1]);
  const maxRaw = Number(match[2]);
  if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw)) return fallback;
  const min = clampNumber(minRaw, bounds.min, bounds.max);
  const max = clampNumber(maxRaw, bounds.min, bounds.max);
  if (min > max) return fallback;
  return { min, max };
};

const aiModeFromEnv = () => oneOf(process.env.AI_MODE, ['off', 'advisory', 'gated-live'] as const, 'off');

const isAiEnabledByEnv = () => {
  const mode = aiModeFromEnv();
  return mode !== 'off';
};

const aiModelFromEnv = () => stringFromEnv(process.env.AI_MODEL, 'gpt-4.1-mini');
const aiPolicyModelFromEnv = () => optionalStringFromEnv(process.env.AI_POLICY_MODEL) || aiModelFromEnv();
const aiStrategyModelFromEnv = () => optionalStringFromEnv(process.env.AI_STRATEGY_MODEL) || aiModelFromEnv();

export type AiAutonomyProfile = 'safe' | 'standard' | 'pro' | 'aggressive';

export const config = {
  env: stringFromEnv(process.env.NODE_ENV, 'development'),
  port: numberFromEnv(process.env.PORT, 8788),
  frontendOrigin: stringFromEnv(process.env.FRONTEND_ORIGIN, 'http://localhost:4173'),
  binanceApiKey: optionalStringFromEnv(process.env.BINANCE_API_KEY),
  binanceApiSecret: optionalStringFromEnv(process.env.BINANCE_API_SECRET),
  binanceBaseUrl: stringFromEnv(process.env.BINANCE_BASE_URL, 'https://api.binance.com'),
  tradeVenue: tradeVenueFromEnv(process.env.TRADE_VENUE),
  futuresEnabled: boolFromEnv(process.env.FUTURES_ENABLED, false),
  futuresBaseUrl: stringFromEnv(process.env.FUTURES_BASE_URL, 'https://fapi.binance.com'),
  futuresLeverage: Math.max(1, Math.min(125, numberFromEnv(process.env.FUTURES_LEVERAGE, 2))),
  futuresMarginType: (stringFromEnv(process.env.FUTURES_MARGIN_TYPE, 'ISOLATED').toUpperCase() === 'CROSSED'
    ? 'CROSSED'
    : 'ISOLATED') as 'ISOLATED' | 'CROSSED',
  tradingEnabled: boolFromEnv(process.env.TRADING_ENABLED, false),

  // AI (OpenAI-compatible)
  aiApiKey: optionalStringFromEnv(process.env.AI_API_KEY),
  aiBaseUrl: optionalStringFromEnv(process.env.AI_BASE_URL),
  aiModel: aiModelFromEnv(),
  aiPolicyModel: aiPolicyModelFromEnv(),
  aiStrategyModel: aiStrategyModelFromEnv(),

  defaultSymbol: stringFromEnv(process.env.SYMBOL, 'BTCEUR').toUpperCase(),
  quoteAsset: stringFromEnv(process.env.QUOTE_ASSET, 'EUR').toUpperCase(),
  homeAsset: stringFromEnv(process.env.HOME_ASSET ?? process.env.QUOTE_ASSET, 'EUR').toUpperCase(),
  // Trade universe (controls candidates + execution gate)
  tradeUniverse: listFromEnvUpper(process.env.TRADE_UNIVERSE, []),
  quoteAssets: listFromEnvUpper(process.env.QUOTE_ASSETS, ['USDT', 'USDC', 'EUR']),
  tradeDenylist: listFromEnvUpper(process.env.TRADE_DENYLIST, []),

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
  autoBlacklistEnabled: boolFromEnv(process.env.AUTO_BLACKLIST_ENABLED, true),
  autoBlacklistTtlMinutes: Math.max(5, Math.floor(numberFromEnv(process.env.AUTO_BLACKLIST_TTL_MIN, 360))),
  autoBlacklistTriggers: (() => {
    const allowed = new Set(['volumeBelowFloor', 'spreadTooHigh', 'volatilitySpike', 'repeatedSlippage']);
    const raw = listFromEnvRaw(process.env.AUTO_BLACKLIST_TRIGGERS, Array.from(allowed));
    return raw
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => allowed.has(t));
  })(),
  persistencePath: stringFromEnv(process.env.PERSISTENCE_PATH, './data/state.json'),
  persistToSqlite: boolFromEnv(process.env.PERSIST_TO_SQLITE, false),
  sqlitePath: stringFromEnv(process.env.SQLITE_PATH, '/app/data/bot.sqlite'),
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
  gridKlineInterval: stringFromEnv(process.env.GRID_KLINE_INTERVAL, '1h'),
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
  gridBuyPauseOnLiquidityHalt: boolFromEnv(process.env.GRID_BUY_PAUSE_ON_LIQUIDITY_HALT, true),
  gridLiquidityResumeTicks: Math.max(1, Math.floor(numberFromEnv(process.env.LIQUIDITY_RESUME_TICKS, 3))),
  gridLiquidityResumeMinutes: Math.max(0, numberFromEnv(process.env.LIQUIDITY_RESUME_MINUTES, 5)),

  // Risk Governor (safe defaults; risk-off bias)
  riskGovernorEnabled: boolFromEnv(process.env.RISK_GOVERNOR_ENABLED, true),
  riskWindowMinutes: Math.max(30, Math.floor(numberFromEnv(process.env.RISK_WINDOW_MINUTES, 360))),
  riskDrawdownCautionPct: Math.max(0, numberFromEnv(process.env.RISK_DRAWDOWN_CAUTION_PCT, 1.0)),
  riskDrawdownHaltPct: Math.max(0, numberFromEnv(process.env.RISK_DRAWDOWN_HALT_PCT, 2.0)),
  riskFeeBurnCautionPct: Math.max(0, numberFromEnv(process.env.RISK_FEE_BURN_CAUTION_PCT, 0.2)),
  riskFeeBurnHaltPct: Math.max(0, numberFromEnv(process.env.RISK_FEE_BURN_HALT_PCT, 0.4)),
  riskTrendAdxOn: Math.max(0, numberFromEnv(process.env.RISK_TREND_ADX_ON, 25)),
  riskTrendAdxOff: Math.max(0, numberFromEnv(process.env.RISK_TREND_ADX_OFF, 18)),
  riskMinStateSeconds: Math.max(0, Math.floor(numberFromEnv(process.env.RISK_MIN_STATE_SECONDS, 300))),
  riskHaltMinSeconds: Math.max(0, Math.floor(numberFromEnv(process.env.RISK_HALT_MIN_SECONDS, 600))),
  riskHaltMarketExit: boolFromEnv(process.env.RISK_HALT_MARKET_EXIT, false),
  riskHaltCancelAllOrders: boolFromEnv(process.env.RISK_HALT_CANCEL_ALL_ORDERS, false),

  // Grid Guard (per-symbol grid BUY pause/resume in bad regimes; SELLs stay active)
  gridGuardEnabled: boolFromEnv(process.env.GRID_GUARD_ENABLED, true),
  gridBreakdownPct: Math.max(0, numberFromEnv(process.env.GRID_BREAKDOWN_PCT, 1.0)),
  gridBreakdownTicks: Math.max(1, Math.floor(numberFromEnv(process.env.GRID_BREAKDOWN_TICKS, 3))),
  gridAtrPctMax: Math.max(0, numberFromEnv(process.env.GRID_ATR_PCT_MAX, 6.0)),
  gridResumeTicks: Math.max(1, Math.floor(numberFromEnv(process.env.GRID_RESUME_TICKS, 3))),
  gridResumeMinutes: Math.max(0, numberFromEnv(process.env.GRID_RESUME_MINUTES, 5)),

  aiMode: aiModeFromEnv(),
  aiPolicyMinIntervalSeconds: numberFromEnv(process.env.AI_POLICY_MIN_INTERVAL_SECONDS, 300),
  aiPolicyMaxCallsPerDay: numberFromEnv(process.env.AI_POLICY_MAX_CALLS_PER_DAY, 200),
  aiPolicyMaxCandidates: numberFromEnv(process.env.AI_POLICY_MAX_CANDIDATES, 8),
  aiPolicyMaxGridAllocIncreasePctPerDay: numberFromEnv(process.env.AI_POLICY_MAX_GRID_ALLOC_INCREASE_PCT_PER_DAY, 5),
  aiPolicyTuningAutoApply: boolFromEnv(process.env.AI_POLICY_TUNING_AUTO_APPLY, false),
  aiPolicySweepAutoApply: boolFromEnv(process.env.AI_POLICY_SWEEP_AUTO_APPLY, false),
  aiPolicySweepCooldownMinutes: numberFromEnv(process.env.AI_POLICY_SWEEP_COOLDOWN_MINUTES, 180),

  // AI policy: risk relaxation is opt-in (safe default false).
  // Used for actions like RESUME_GRID (treat as increasing risk unless explicitly allowed by operator).
  aiPolicyAllowRiskRelaxation: boolFromEnv(process.env.AI_POLICY_ALLOW_RISK_RELAXATION, false),

  // AI autonomy & slow-loop coach (additive; safe defaults)
  aiAutonomyProfile: oneOf(process.env.AI_AUTONOMY_PROFILE, ['safe', 'standard', 'pro', 'aggressive'] as const, 'safe') as AiAutonomyProfile,
  aiCoachEnabled: boolFromEnv(process.env.AI_COACH_ENABLED, isAiEnabledByEnv()),
  aiCoachIntervalSeconds: Math.max(60, Math.floor(numberFromEnv(process.env.AI_COACH_INTERVAL_SECONDS, 600))),
  aiCoachMinEquityUsd: Math.max(0, numberFromEnv(process.env.AI_COACH_MIN_EQUITY_USD, 200)),
  aiTuningEnvelope: {
    minQuoteVolume: parseRangeFromEnv(process.env.MIN_QUOTE_VOLUME_RANGE, { min: 3_000_000, max: 30_000_000 }, runtimeBounds.minQuoteVolume),
    maxVolatilityPercent: parseRangeFromEnv(process.env.MAX_VOLATILITY_RANGE, { min: 6, max: 18 }, runtimeBounds.maxVolatilityPercent),
    riskPerTradeBasisPoints: parseRangeFromEnv(process.env.RISK_BP_RANGE, { min: 10, max: 60 }, runtimeBounds.riskPerTradeBasisPoints),
    portfolioMaxPositions: parseRangeFromEnv(process.env.PORTFOLIO_MAX_POS_RANGE, { min: 1, max: 4 }, runtimeBounds.portfolioMaxPositions),
    gridMaxAllocPct: parseRangeFromEnv(process.env.GRID_MAX_ALLOC_RANGE, { min: 10, max: 35 }, runtimeBounds.gridMaxAllocPct),
  },
  apiRateLimitMax: Math.max(1, Math.floor(numberFromEnv(process.env.API_RATE_LIMIT_MAX, 120))),
  apiRateLimitWindowSeconds: Math.max(1, Math.floor(numberFromEnv(process.env.API_RATE_LIMIT_WINDOW_SECONDS, 10))),
  apiKey: optionalStringFromEnv(process.env.API_KEY),
  clientKey: optionalStringFromEnv(process.env.CLIENT_KEY),
};

export const feeRate = {
  maker: 0.001,
  taker: 0.001,
};

export const applyRuntimeConfigOverrides = (overrides: RuntimeConfigOverrides, options?: { mutate?: boolean }) => {
  const mutate = options?.mutate ?? true;
  const applied: RuntimeConfigOverrides = {};

  if (overrides.minQuoteVolume !== undefined && Number.isFinite(overrides.minQuoteVolume)) {
    const bounded = clampNumber(
      Math.floor(overrides.minQuoteVolume),
      runtimeBounds.minQuoteVolume.min,
      runtimeBounds.minQuoteVolume.max,
    );
    if (mutate) config.minQuoteVolume = bounded;
    applied.minQuoteVolume = bounded;
  }

  if (overrides.maxVolatilityPercent !== undefined && Number.isFinite(overrides.maxVolatilityPercent)) {
    const bounded = clampNumber(
      overrides.maxVolatilityPercent,
      runtimeBounds.maxVolatilityPercent.min,
      runtimeBounds.maxVolatilityPercent.max,
    );
    if (mutate) config.maxVolatilityPercent = bounded;
    applied.maxVolatilityPercent = bounded;
  }

  if (overrides.riskPerTradeBasisPoints !== undefined && Number.isFinite(overrides.riskPerTradeBasisPoints)) {
    const bounded = clampNumber(
      overrides.riskPerTradeBasisPoints,
      runtimeBounds.riskPerTradeBasisPoints.min,
      runtimeBounds.riskPerTradeBasisPoints.max,
    );
    if (mutate) config.riskPerTradeBasisPoints = bounded;
    applied.riskPerTradeBasisPoints = bounded;
  }

  if (overrides.autoTradeHorizon !== undefined) {
    const v = overrides.autoTradeHorizon.toLowerCase() as RuntimeConfigOverrides['autoTradeHorizon'];
    if (v === 'short' || v === 'medium' || v === 'long') {
      if (mutate) config.autoTradeHorizon = v;
      applied.autoTradeHorizon = v;
    }
  }

  if (overrides.portfolioMaxAllocPct !== undefined && Number.isFinite(overrides.portfolioMaxAllocPct)) {
    const bounded = clampNumber(
      overrides.portfolioMaxAllocPct,
      runtimeBounds.portfolioMaxAllocPct.min,
      runtimeBounds.portfolioMaxAllocPct.max,
    );
    if (mutate) config.portfolioMaxAllocPct = bounded;
    applied.portfolioMaxAllocPct = bounded;
  }

  if (overrides.portfolioMaxPositions !== undefined && Number.isFinite(overrides.portfolioMaxPositions)) {
    const bounded = clampNumber(
      Math.floor(overrides.portfolioMaxPositions),
      runtimeBounds.portfolioMaxPositions.min,
      runtimeBounds.portfolioMaxPositions.max,
    );
    if (mutate) config.portfolioMaxPositions = bounded;
    applied.portfolioMaxPositions = bounded;
  }

  if (overrides.gridMaxAllocPct !== undefined && Number.isFinite(overrides.gridMaxAllocPct)) {
    const bounded = clampNumber(overrides.gridMaxAllocPct, runtimeBounds.gridMaxAllocPct.min, runtimeBounds.gridMaxAllocPct.max);
    if (mutate) config.gridMaxAllocPct = bounded;
    applied.gridMaxAllocPct = bounded;
  }

  return applied;
};
