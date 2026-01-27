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

export interface GridOrder {
  orderId: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  placedAt: number;
  lastSeenAt?: number;
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
  positions?: Record<
    string,
    {
      symbol: string;
      horizon: Horizon;
      side: 'BUY' | 'SELL';
      entryPrice: number;
      size: number;
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
