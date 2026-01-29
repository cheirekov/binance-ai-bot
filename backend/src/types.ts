export type Horizon = 'short' | 'medium' | 'long';

export type Side = 'BUY' | 'SELL';

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

export interface MarketSnapshot {
  symbol: string;
  price: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume?: number;
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
  side: Side;
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

export interface RiskSettings {
  maxPositionSizeUsdt: number;
  riskPerTradeFraction: number;
  feeRate: {
    maker: number;
    taker: number;
  };
}

export interface EntryPlan {
  side: Side;
  priceTarget: number;
  size: number;
  confidence: number;
}

export interface ExitPlan {
  stopLoss: number;
  takeProfit: number[];
  timeframeMinutes: number;
}

export interface StrategyPlan {
  horizon: Horizon;
  thesis: string;
  entries: EntryPlan[];
  exitPlan: ExitPlan;
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

export interface StrategyState {
  market: MarketSnapshot | null;
  balances: Balance[];
  strategies: StrategyBundle | null;
  lastUpdated: number | null;
  status: 'idle' | 'refreshing' | 'error' | 'ready';
  error?: string;
  riskFlags: string[];
  tradeHalted: boolean;
}

export interface StrategyResponsePayload {
  status: StrategyState['status'];
  symbol: string;
  market: MarketSnapshot | null;
  balances: Balance[];
  strategies: StrategyBundle | null;
  risk: RiskSettings;
  quoteAsset: string;
  minQuoteVolume?: number;
  maxVolatilityPercent?: number;
  autoTradeHorizon?: Horizon;
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
  positions?: PersistedPayload['positions'];
  grids?: PersistedPayload['grids'];
  gridEnabled?: boolean;
  gridMaxAllocPct?: number;
  gridMaxActiveGrids?: number;
  gridLevels?: number;
  gridRebalanceSeconds?: number;
  equity?: NonNullable<PersistedPayload['meta']>['equity'];
  aiPolicyMode?: AiPolicyMode;
  aiPolicy?: NonNullable<PersistedPayload['meta']>['aiPolicy'];
  runtimeConfig?: NonNullable<PersistedPayload['meta']>['runtimeConfig'];
  emergencyStop?: boolean;
  emergencyStopAt?: number;
  emergencyStopReason?: string;
  lastUpdated: number | null;
  error?: string;
  riskFlags: string[];
  tradeHalted: boolean;
}

export interface PersistedPayload {
  strategies: Record<string, StrategyResponsePayload>;
  lastTrades: Record<string, number>;
  positions: Record<
    string,
    {
      symbol: string;
      horizon: Horizon;
      side: Side;
      entryPrice: number;
      plannedEntryPrice?: number;
      executedAvgPrice?: number;
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
  grids: Record<string, GridState>;
  meta?: {
    activeSymbol?: string;
    autoSelectUpdatedAt?: number;
    rankedCandidates?: { symbol: string; score: number }[];
    rankedGridCandidates?: { symbol: string; score: number }[];
    gridUpdatedAt?: number;
    gridRebalanceAt?: number;
    lastAutoTrade?: StrategyResponsePayload['lastAutoTrade'];
    aiPolicy?: {
      date: string;
      calls: number;
      lastAt?: number;
      lastDecision?: AiPolicyDecision;
    };
    runtimeConfig?: {
      updatedAt: number;
      source?: 'manual' | 'ai';
      reason?: string;
      values: AiPolicyTuning;
    };
    ocoReconcileAt?: number;
    emergencyStop?: boolean;
    emergencyStopAt?: number;
    emergencyStopReason?: string;
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
    accountBlacklist?: Record<string, { at: number; reason: string }>;
    conversions?: {
      date: string;
      count: number;
      lastAt?: number;
    };
    aiSweeps?: {
      date: string;
      count: number;
      lastAt?: number;
    };
    aiTuning?: {
      date: string;
      gridMaxAllocIncreasePct: number;
      lastAt?: number;
    };
  };
}
