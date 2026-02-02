import { z } from 'zod';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { Horizon, MarketSnapshot, RiskSettings } from '../types.js';

import { callJson } from './jsonCall.js';

const cacheTtlMs = 30 * 60 * 1000;
const insightCache: Record<string, { fetchedAt: number; value: AiInsight }> = {};

export interface AiInsight {
  rationale: string;
  cautions: string[];
  confidence: number;
}

const aiInsightSchema = z
  .object({
    rationale: z.string().min(1).max(1200),
    cautions: z.array(z.string().min(1).max(200)).max(12),
    confidence: z.number().min(0).max(1),
  })
  .strict();

interface PromptInput {
  horizon: Horizon;
  market: MarketSnapshot;
  risk: RiskSettings;
}

const systemPrompt = `You are a professional quantitative crypto trader.
Return concise JSON with fields: rationale (string), cautions (string array), confidence (0-1).
Be explicit about risk controls, Binance spot fees (0.1% maker/taker), and avoid over-trading.
Prefer practical, testable signals over vague language.`;

const buildUserPrompt = (input: PromptInput) => {
  const window = input.horizon === 'short' ? 'next few hours' : input.horizon === 'medium' ? 'coming days' : 'multi-week';

  return `Symbol: ${input.market.symbol}
Current price: ${input.market.price}
24h change: ${input.market.priceChangePercent}%
High/Low: ${input.market.highPrice}/${input.market.lowPrice}
Volume: ${input.market.volume}
Horizon: ${input.horizon} (${window})
Risk: risk-per-trade ${(input.risk.riskPerTradeFraction * 100).toFixed(2)}% | max position ${input.risk.maxPositionSizeUsdt} USDT
Fee rate: maker ${input.risk.feeRate.maker}, taker ${input.risk.feeRate.taker}
Return the JSON now.`;
};

export const generateAiInsight = async (input: PromptInput): Promise<AiInsight> => {
  const cacheKey = `${input.market.symbol}:${input.horizon}:${config.aiStrategyModel}`;
  const cached = insightCache[cacheKey];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < cacheTtlMs) return cached.value;

  const res = await callJson({
    schema: aiInsightSchema,
    model: config.aiStrategyModel,
    temperature: 0.4,
    timeoutMs: 45_000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });

  if (!res.ok) {
    logger.warn({ error: res.error }, 'AI insight call failed; falling back to heuristics');
    return {
      rationale: config.aiApiKey
        ? 'AI output could not be validated; using heuristic-only guidance.'
        : 'AI key missing. Using heuristic-only guidance; keep risk tight.',
      cautions: config.aiApiKey
        ? ['Prefer risk control over activity', 'Avoid live trading without confirmation']
        : ['Configure AI_API_KEY to enable AI reinforcement', 'Avoid live trading without confirmation'],
      confidence: 0.3,
    };
  }

  const insight = res.data;
  insightCache[cacheKey] = { fetchedAt: now, value: insight };
  return insight;
};
