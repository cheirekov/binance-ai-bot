export type Horizon = 'short' | 'medium' | 'long';

export interface MarketSnapshot {
  symbol: string;
  price: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  updatedAt: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
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
  quoteAsset: string;
  availableSymbols: string[];
  lastUpdated: number | null;
  error?: string;
  riskFlags?: string[];
  tradeHalted?: boolean;
}
