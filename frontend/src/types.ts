export type Horizon = 'short' | 'medium' | 'long';

export interface MarketSnapshot {
  symbol: string;
  price: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  updatedAt: number;
  quoteAsset?: string;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export type GridStatus = 'running' | 'stopped' | 'error';

export type AiPolicyMode = 'off' | 'advisory' | 'gated-live';

export type AiPolicyAction = 'HOLD' | 'OPEN' | 'CLOSE' | 'PANIC';

export interface AiPolicyTuning {
  minQuoteVolume?: number;
  maxVolatilityPercent?: number;
  autoTradeHorizon?: Horizon;
  portfolioMaxAllocPct?: number;
  portfolioMaxPositions?: number;
  gridMaxAllocPct?: number;
}

export interface AiPolicyDecision {
  at: number;
  mode: AiPolicyMode;
  action: AiPolicyAction;
  symbol?: string;
  horizon?: Horizon;
  positionKey?: string;
  confidence: number;
  reason: string;
  model?: string;
  tune?: AiPolicyTuning;
  sweepUnusedToHome?: boolean;
}

export interface AiPolicyMeta {
  date: string;
  calls: number;
  lastAt?: number;
  lastDecision?: AiPolicyDecision;
}

export interface GridOrder {
  orderId: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  placedAt: number;
  lastSeenAt?: number;
}

export interface GridPerformance {
  startAt: number;
  startValueHome: number;
  lastAt: number;
  lastValueHome: number;
  pnlHome: number;
  pnlPct: number;
  baseVirtual: number;
  quoteVirtual: number;
  feesHome: number;
  fillsBuy: number;
  fillsSell: number;
  lastFillAt?: number;
  breakouts: number;
}

export interface GridState {
  symbol: string;
  status: GridStatus;
  baseAsset: string;
  quoteAsset: string;
  homeAsset: string;
  lowerPrice: number;
  upperPrice: number;
  levels: number;
  prices: number[];
  orderNotionalHome: number;
  allocationHome: number;
  bootstrapBasePct: number;
  createdAt: number;
  updatedAt: number;
  lastTickAt?: number;
  lastError?: string;
  ordersByLevel: Record<string, GridOrder>;
  performance?: GridPerformance;
}

export interface StrategyPlan {
  horizon: Horizon;
  thesis: string;
  entries: {
    side: 'BUY' | 'SELL';
    priceTarget: number;
    size: number;
    confidence: number;
  }[];
  exitPlan: {
    stopLoss: number;
    takeProfit: number[];
    timeframeMinutes: number;
  };
  riskRewardRatio: number;
  estimatedFees: number;
  signalsUsed: string[];
  aiNotes?: string;
  createdAt: number;
}

export interface StrategyBundle {
  short: StrategyPlan;
  medium: StrategyPlan;
  long: StrategyPlan;
}

export interface StrategyResponse {
  symbol: string;
  status: string;
  market: MarketSnapshot | null;
  balances: Balance[];
  strategies: StrategyBundle | null;
  risk: {
    maxPositionSizeUsdt: number;
    riskPerTradeFraction: number;
    feeRate: { maker: number; taker: number };
  };
  availableSymbols: string[];
  minQuoteVolume?: number;
  maxVolatilityPercent?: number;
  autoTradeHorizon?: Horizon;
  tradeVenue?: 'spot' | 'futures';
  futuresEnabled?: boolean;
  futuresLeverage?: number;
  tradingEnabled?: boolean;
  autoTradeEnabled?: boolean;
  homeAsset?: string;
  portfolioEnabled?: boolean;
  portfolioMaxAllocPct?: number;
  portfolioMaxPositions?: number;
  conversionEnabled?: boolean;
  gridEnabled?: boolean;
  gridMaxAllocPct?: number;
  gridMaxActiveGrids?: number;
  gridLevels?: number;
  gridRebalanceSeconds?: number;
  activeSymbol?: string;
  autoSelectUpdatedAt?: number | null;
  rankedCandidates?: { symbol: string; score: number }[];
  rankedGridCandidates?: { symbol: string; score: number }[];
  gridUpdatedAt?: number | null;
  lastAutoTrade?: {
    at: number;
    symbol: string;
    horizon?: Horizon;
    action: 'skipped' | 'placed' | 'error';
    reason?: string;
    orderId?: string | number;
  };
  aiPolicyMode?: AiPolicyMode;
  aiPolicy?: AiPolicyMeta;
  runtimeConfig?: {
    updatedAt: number;
    source?: 'manual' | 'ai';
    reason?: string;
    values: AiPolicyTuning;
  };
  positions?: Record<
    string,
    {
      symbol: string;
      horizon: Horizon;
      side: 'BUY' | 'SELL';
      entryPrice: number;
      size: number;
      stopLoss?: number;
      takeProfit?: number[];
      baseAsset?: string;
      quoteAsset?: string;
      homeAsset?: string;
      notionalHome?: number;
      ocoOrderListId?: number;
      venue?: 'spot' | 'futures';
      leverage?: number;
      openedAt: number;
    }
  >;
  grids?: Record<string, GridState>;
  equity?: {
    homeAsset: string;
    startAt: number;
    startHome: number;
    lastAt: number;
    lastHome: number;
    pnlHome: number;
    pnlPct: number;
    missingAssets?: string[];
  };
  lastUpdated: number | null;
  error?: string;
  riskFlags?: string[];
  tradeHalted?: boolean;
  quoteAsset?: string;
  emergencyStop?: boolean;
  emergencyStopAt?: number;
  emergencyStopReason?: string;
}

export interface PanicLiquidateResponse {
  ok: boolean;
  dryRun: boolean;
  homeAsset: string;
  emergencyStop: boolean;
  summary: { placed: number; skipped: number; errored: number; stillHeld: number };
  actions: Array<
    | { asset: string; symbol: string; side: 'BUY' | 'SELL'; requestedQty: number; status: 'placed' | 'simulated'; orderId?: string | number; executedQty?: number }
    | { asset: string; status: 'skipped'; reason: string }
    | { asset: string; symbol?: string; status: 'error'; reason: string }
  >;
  balances: Balance[];
}

export interface SweepUnusedResponse extends PanicLiquidateResponse {
  protectedAssets?: string[];
}

export interface OrderBotContext {
  source: 'grid' | 'position' | 'unknown';
  gridSymbol?: string;
  gridLevel?: string;
  positionKey?: string;
  ocoOrderListId?: number;
  ai?: {
    at: number;
    action: AiPolicyAction;
    confidence: number;
    symbol?: string;
    horizon?: Horizon;
    positionKey?: string;
    reason: string;
  };
}

export interface OrderRow {
  symbol: string;
  orderId: number;
  clientOrderId?: string;
  orderListId?: number;
  side: string;
  type: string;
  status: string;
  timeInForce?: string;
  price: number;
  stopPrice?: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  time: number;
  updateTime: number;
  bot?: OrderBotContext;
}

export interface OpenOrdersResponse {
  ok: boolean;
  venue: 'spot' | 'futures';
  symbols: string[];
  openOrders: OrderRow[];
}

export interface OrderHistoryResponse {
  ok: boolean;
  venue: 'spot' | 'futures';
  symbol: string;
  orders: OrderRow[];
}

export interface PerformanceStatsResponse {
  enabled: boolean;
  path?: string;
  totalTrades: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number | null;
  totalFees: number;
  netPnlByDay: Array<{ day: string; netPnlHome: number; feesHome: number }>;
  lastErrorAt?: number | null;
}

export interface DbStatsResponse {
  persistToSqlite: boolean;
  sqliteFile?: string;
  counts: { market_features: number; decisions: number; trades: number };
  lastWriteAt: number | null;
  lastError?: string;
}
