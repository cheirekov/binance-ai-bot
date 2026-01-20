import dotenv from 'dotenv';

dotenv.config();

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  symbol: process.env.SYMBOL ?? 'BTCUSDT',
  quoteAsset: process.env.QUOTE_ASSET ?? 'USDT',
  maxPositionSizeUsdt: numberFromEnv(process.env.MAX_POSITION_SIZE_USDT, 200),
  riskPerTradeBasisPoints: numberFromEnv(process.env.RISK_PER_TRADE_BP, 50),
  refreshSeconds: numberFromEnv(process.env.REFRESH_SECONDS, 30),
};

export const feeRate = {
  maker: 0.001,
  taker: 0.001,
};
