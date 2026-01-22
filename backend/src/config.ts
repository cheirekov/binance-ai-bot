import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const listFromEnv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: numberFromEnv(process.env.PORT, 8788),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173',
  binanceApiKey: process.env.BINANCE_API_KEY ?? '',
  binanceApiSecret: process.env.BINANCE_API_SECRET ?? '',
  binanceBaseUrl: process.env.BINANCE_BASE_URL ?? 'https://api.binance.com',
  tradingEnabled: (process.env.TRADING_ENABLED ?? 'false').toLowerCase() === 'true',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  defaultSymbol: (process.env.SYMBOL ?? 'BTCEUR').toUpperCase(),
  quoteAsset: (process.env.QUOTE_ASSET ?? 'EUR').toUpperCase(),
  allowedSymbols: listFromEnv(process.env.ALLOWED_SYMBOLS, [
    'BTCEUR',
    'ETHEUR',
    'BTCUSDT',
    'ETHUSDT',
    'BTCUSDC',
    'ETHUSDC',
    'SOLUSDT',
    'BNBUSDT',
  ]),
  allowedQuoteAssets: listFromEnv(process.env.ALLOWED_QUOTES, ['USDT', 'USDC', 'EUR']),
  maxPositionSizeUsdt: numberFromEnv(process.env.MAX_POSITION_SIZE_USDT, 200),
  riskPerTradeBasisPoints: numberFromEnv(process.env.RISK_PER_TRADE_BP, 50),
  refreshSeconds: numberFromEnv(process.env.REFRESH_SECONDS, 30),
  autoSelectSymbol: (process.env.AUTO_SELECT_SYMBOL ?? 'false').toLowerCase() === 'true',
  autoDiscoverSymbols: (process.env.AUTO_DISCOVER_SYMBOLS ?? 'true').toLowerCase() === 'true',
  minQuoteVolume: numberFromEnv(process.env.MIN_QUOTE_VOLUME, 5_000_000),
  maxVolatilityPercent: numberFromEnv(process.env.MAX_VOLATILITY_PCT, 18),
  newsFeeds: listFromEnv(
    process.env.NEWS_FEEDS,
    ['https://rss.app/feeds/tJm8nlqwIBwQnS5s.xml', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ),
  newsCacheMinutes: numberFromEnv(process.env.NEWS_CACHE_MINUTES, 15),
  newsWeight: numberFromEnv(process.env.NEWS_WEIGHT, 2),
  blacklistSymbols: listFromEnv(process.env.BLACKLIST_SYMBOLS, []),
  persistencePath: process.env.PERSISTENCE_PATH ?? './data/state.json',
  autoTradeEnabled: (process.env.AUTO_TRADE_ENABLED ?? 'false').toLowerCase() === 'true',
  autoTradeHorizon: (process.env.AUTO_TRADE_HORIZON ?? 'short').toLowerCase() as 'short' | 'medium' | 'long',
  autoTradeMinConfidence: numberFromEnv(process.env.AUTO_TRADE_MIN_CONFIDENCE, 55) / 100,
  autoTradeCooldownMinutes: numberFromEnv(process.env.AUTO_TRADE_COOLDOWN_MINUTES, 90),
  dailyLossCapPct: numberFromEnv(process.env.DAILY_LOSS_CAP_PCT, 3),
  slippageBps: numberFromEnv(process.env.SLIPPAGE_BPS, 8),
  ocoEnabled: (process.env.OCO_ENABLED ?? 'true').toLowerCase() === 'true',
  apiKey: process.env.API_KEY ?? '',
  clientKey: process.env.CLIENT_KEY ?? '',
};

export const feeRate = {
  maker: 0.001,
  taker: 0.001,
};
