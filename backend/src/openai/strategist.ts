import OpenAI from 'openai';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { Horizon, MarketSnapshot, RiskSettings } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';

const client = config.openAiApiKey
  ? new OpenAI({ apiKey: config.openAiApiKey, baseURL: config.openAiBaseUrl || undefined })
  : null;
const cacheTtlMs = 30 * 60 * 1000;
const insightCache: Record<string, { fetchedAt: number; value: AiInsight }> = {};

export interface AiInsight {
  rationale: string;
  cautions: string[];
  confidence: number;
}

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
  const window =
    input.horizon === 'short' ? 'next few hours' : input.horizon === 'medium' ? 'coming days' : 'multi-week';

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
  const cacheKey = `${input.market.symbol}:${input.horizon}:${config.openAiModel}`;
  const cached = insightCache[cacheKey];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < cacheTtlMs) {
    return cached.value;
  }

  if (!client) {
    return {
      rationale: 'OpenAI key missing. Using heuristic-only guidance; keep risk tight.',
      cautions: ['Configure OPENAI_API_KEY to enable AI reinforcement', 'Avoid live trading without confirmation'],
      confidence: 0.3,
    };
  }

  try {
    const completion = await client.chat.completions.create({
      model: config.openAiModel,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as AiInsight;

    const insight = {
      rationale: parsed.rationale ?? 'AI returned no rationale',
      cautions: parsed.cautions ?? [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
    insightCache[cacheKey] = { fetchedAt: now, value: insight };
    return insight;
  } catch (error) {
    logger.error({ err: errorToLogObject(error) }, 'OpenAI call failed; falling back to heuristics');
    return {
      rationale: 'AI call failed; operate on heuristics and keep exposure minimal.',
      cautions: ['Retry once network stabilises', 'Keep position size below 0.5% until AI resumes'],
      confidence: 0.4,
    };
  }
};
