import { config } from '../config.js';
import { generateAiInsight } from '../openai/strategist.js';
import { Horizon, MarketSnapshot, RiskSettings, Side, StrategyBundle, StrategyPlan } from '../types.js';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const priceDigitsFor = (price: number): number => {
  const abs = Math.abs(price);
  if (!Number.isFinite(abs) || abs === 0) return 8;
  if (abs >= 1000) return 2;
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  if (abs >= 0.0001) return 8;
  return 10;
};

const qtyDigitsFor = (qty: number): number => {
  const abs = Math.abs(qty);
  if (!Number.isFinite(abs) || abs === 0) return 8;
  if (abs >= 1000) return 2;
  if (abs >= 100) return 3;
  if (abs >= 10) return 4;
  if (abs >= 1) return 6;
  return 8;
};

const pickSide = (changePercent: number): Side => {
  if (changePercent > 2) return 'BUY';
  if (changePercent < -2) return 'SELL';
  return changePercent >= 0 ? 'BUY' : 'SELL';
};

const pickTimeframe = (horizon: Horizon): number => {
  switch (horizon) {
    case 'short':
      return 120;
    case 'medium':
      return 24 * 60;
    case 'long':
    default:
      return 7 * 24 * 60;
  }
};

const riskRewardByHorizon = (horizon: Horizon): number => {
  if (horizon === 'short') return 1.5;
  if (horizon === 'medium') return 2.0;
  return 2.5;
};

const buildHeuristicPlan = (
  horizon: Horizon,
  market: MarketSnapshot,
  risk: RiskSettings,
  aiNotes: string,
  newsSentiment: number,
  quoteUsd: number,
): StrategyPlan => {
  const side = pickSide(market.priceChangePercent);
  const volatility = (market.highPrice - market.lowPrice) / market.price;
  const volFactor = clamp(volatility, 0.001, 0.05);
  const rr = riskRewardByHorizon(horizon);
  const baseBuffer = horizon === 'short' ? 0.0025 : horizon === 'medium' ? 0.01 : 0.02;
  const stopDistance = baseBuffer + volFactor;

  const stopLoss =
    side === 'BUY'
      ? market.price * (1 - stopDistance)
      : market.price * (1 + stopDistance);

  const takeProfitStep = stopDistance * rr;
  const takeProfit =
    side === 'BUY'
      ? [market.price * (1 + takeProfitStep), market.price * (1 + takeProfitStep * 1.4)]
      : [market.price * (1 - takeProfitStep), market.price * (1 - takeProfitStep * 1.4)];

  const capitalAtRiskUsd = risk.maxPositionSizeUsdt * risk.riskPerTradeFraction;
  const riskPerUnitUsd = stopDistance * market.price * Math.max(quoteUsd, 0.0001);
  const rawSize = riskPerUnitUsd > 0 ? capitalAtRiskUsd / riskPerUnitUsd : 0;
  const slippageFactor = Math.max(0, 1 - config.slippageBps / 10000);
  const maxQtyByNotional =
    risk.maxPositionSizeUsdt / Math.max(market.price * Math.max(quoteUsd, 0.0001), 0.00000001);
  const size = clamp(rawSize * slippageFactor, 0, maxQtyByNotional);
  const feeEstimate = size * market.price * (risk.feeRate.taker * 2);

  const priceDigits = priceDigitsFor(market.price);
  const qtyDigits = qtyDigitsFor(size);

  return {
    horizon,
    thesis:
      side === 'BUY'
        ? 'Momentum bias to the upside; aim to compound with tight stops.'
        : 'Downside pressure detected; short-term hedge with controlled exposure.',
    entries: [
      {
        side,
        priceTarget: market.price,
        size: Number(size.toFixed(qtyDigits)),
        confidence: clamp(0.55 + market.priceChangePercent / 100, 0.2, 0.8),
      },
    ],
    exitPlan: {
      stopLoss: Number(stopLoss.toFixed(priceDigits)),
      takeProfit: takeProfit.map((v) => Number(v.toFixed(priceDigits))),
      timeframeMinutes: pickTimeframe(horizon),
    },
    riskRewardRatio: rr,
    estimatedFees: Number(feeEstimate.toFixed(priceDigits)),
    signalsUsed: [
      `24h momentum ${market.priceChangePercent.toFixed(2)}%`,
      `Volatility ${(volFactor * 100).toFixed(2)}%`,
      `News sentiment ${(newsSentiment ?? 0).toFixed(2)}`,
    ],
    aiNotes,
    createdAt: Date.now(),
  };
};

export const buildStrategyBundle = async (
  market: MarketSnapshot,
  risk: RiskSettings,
  newsSentiment: number,
  quoteUsd: number,
  options?: { useAi?: boolean },
): Promise<StrategyBundle> => {
  const useAi = options?.useAi ?? true;
  const [aiShort, aiMedium, aiLong] = useAi
    ? await Promise.all([
        generateAiInsight({ horizon: 'short', market, risk }),
        generateAiInsight({ horizon: 'medium', market, risk }),
        generateAiInsight({ horizon: 'long', market, risk }),
      ])
    : [
        { rationale: '', cautions: [], confidence: 0.0 },
        { rationale: '', cautions: [], confidence: 0.0 },
        { rationale: '', cautions: [], confidence: 0.0 },
      ];

  return {
    short: buildHeuristicPlan('short', market, risk, aiShort.rationale, newsSentiment, quoteUsd),
    medium: buildHeuristicPlan('medium', market, risk, aiMedium.rationale, newsSentiment, quoteUsd),
    long: buildHeuristicPlan('long', market, risk, aiLong.rationale, newsSentiment, quoteUsd),
  };
};
