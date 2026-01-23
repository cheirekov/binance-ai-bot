export type Horizon = 'short' | 'medium' | 'long';

export type Side = 'BUY' | 'SELL';

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
  availableSymbols: string[];
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
  lastAutoTrade?: {
    at: number;
    symbol: string;
    horizon?: Horizon;
    action: 'skipped' | 'placed' | 'error';
    reason?: string;
    orderId?: string | number;
  };
  positions?: PersistedPayload['positions'];
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
      size: number;
      stopLoss?: number;
      takeProfit?: number[];
      baseAsset?: string;
      quoteAsset?: string;
      homeAsset?: string;
      notionalHome?: number;
      ocoOrderListId?: number;
      openedAt: number;
    }
  >;
  meta?: {
    activeSymbol?: string;
    autoSelectUpdatedAt?: number;
    rankedCandidates?: { symbol: string; score: number }[];
    lastAutoTrade?: StrategyResponsePayload['lastAutoTrade'];
    ocoReconcileAt?: number;
    emergencyStop?: boolean;
    emergencyStopAt?: number;
    emergencyStopReason?: string;
    accountBlacklist?: Record<string, { at: number; reason: string }>;
    conversions?: {
      date: string;
      count: number;
      lastAt?: number;
    };
  };
}
