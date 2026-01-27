import OpenAI from 'openai';
import { z } from 'zod';

import { get24hStats } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AiPolicyDecision, Horizon } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistMeta } from './persistence.js';

const persisted = getPersistedState();
const client = config.openAiApiKey
  ? new OpenAI({ apiKey: config.openAiApiKey, baseURL: config.openAiBaseUrl || undefined })
  : null;

const todayKey = () => new Date().toISOString().slice(0, 10);

const decisionSchema = z.object({
  action: z.enum(['HOLD', 'OPEN', 'CLOSE', 'PANIC']),
  symbol: z.string().min(3).max(20).optional(),
  horizon: z.enum(['short', 'medium', 'long']).optional(),
  positionKey: z.string().min(3).max(64).optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(400),
});

const getPolicyMeta = () => {
  const meta = persisted.meta?.aiPolicy;
  const today = todayKey();
  if (!meta || meta.date !== today) return { date: today, calls: 0, lastAt: undefined as number | undefined, lastDecision: undefined as AiPolicyDecision | undefined };
  return meta;
};

const canCallPolicyNow = (now: number) => {
  const meta = getPolicyMeta();
  const minMs = Math.max(0, config.aiPolicyMinIntervalSeconds) * 1000;
  if (meta.lastAt && now - meta.lastAt < minMs) return { ok: false as const, reason: 'rate_limit_interval' };
  if (meta.calls >= Math.max(0, config.aiPolicyMaxCallsPerDay)) return { ok: false as const, reason: 'rate_limit_daily' };
  return { ok: true as const };
};

const buildCandidates = async (seedSymbol?: string) => {
  const ranked = persisted.meta?.rankedCandidates ?? [];
  const base = ranked.map((c) => c.symbol.toUpperCase());
  const initial = base.length ? base : config.allowedSymbols.map((s) => s.toUpperCase());
  const merged = Array.from(new Set([seedSymbol?.toUpperCase(), ...initial].filter(Boolean) as string[]));

  const blocked = new Set(Object.keys(persisted.meta?.accountBlacklist ?? {}).map((s) => s.toUpperCase()));
  const gridRunning = new Set(Object.values(persisted.grids ?? {}).filter((g) => g?.status === 'running').map((g) => g.symbol.toUpperCase()));

  const symbols = await fetchTradableSymbols();
  const allowed = new Set(symbols.map((s) => s.symbol.toUpperCase()));

  const candidates: Array<{
    symbol: string;
    score?: number;
    price?: number;
    priceChangePercent?: number;
    volatilityPct?: number;
    quoteVolume?: number;
    tradeHalted?: boolean;
    riskFlags?: string[];
  }> = [];

  for (const sym of merged.slice(0, Math.max(1, config.aiPolicyMaxCandidates))) {
    if (blocked.has(sym)) continue;
    if (!allowed.has(sym)) continue;
    if (gridRunning.has(sym)) continue;
    try {
      const snap = await get24hStats(sym);
      const volPct = Math.abs((snap.highPrice - snap.lowPrice) / Math.max(snap.price, 0.00000001)) * 100;
      const stored = persisted.strategies?.[sym];
      candidates.push({
        symbol: sym,
        score: ranked.find((c) => c.symbol.toUpperCase() === sym)?.score,
        price: snap.price,
        priceChangePercent: snap.priceChangePercent,
        volatilityPct: volPct,
        quoteVolume: snap.quoteVolume ?? 0,
        tradeHalted: stored?.tradeHalted,
        riskFlags: stored?.riskFlags ?? [],
      });
    } catch {
      // ignore
    }
  }

  return candidates;
};

const buildOpenPositions = () =>
  Object.entries(persisted.positions)
    .filter(([, p]) => (p?.venue ?? 'spot') === config.tradeVenue)
    .map(([key, p]) => ({
      key,
      symbol: p?.symbol ?? '',
      horizon: p?.horizon ?? 'short',
      side: p?.side ?? 'BUY',
      notionalHome: p?.notionalHome ?? 0,
      openedAt: p?.openedAt ?? 0,
    }))
    .filter((p) => p.key && p.symbol);

const systemPrompt = `You are a trading policy engine for a crypto bot.
Return ONLY a JSON object with keys:
- action: one of HOLD | OPEN | CLOSE | PANIC
- symbol?: string (required when action=OPEN)
- horizon?: short|medium|long (required when action=OPEN)
- positionKey?: string (required when action=CLOSE; must match exactly one provided open position key)
- confidence: number 0..1
- reason: short string (<= 400 chars)

Hard rules:
- NEVER invent symbols or positionKey. Choose ONLY from the provided lists.
- If you are uncertain, choose HOLD.
- Prefer risk control over activity.`;

const userPrompt = (payload: {
  venue: string;
  homeAsset: string;
  portfolioEnabled: boolean;
  portfolioMaxPositions: number;
  openPositions: ReturnType<typeof buildOpenPositions>;
  candidates: Awaited<ReturnType<typeof buildCandidates>>;
  newsSentiment: number;
}) => `Context (JSON):
${JSON.stringify(payload, null, 2)}

Decide now.`;

export const runAiPolicy = async (seedSymbol?: string): Promise<AiPolicyDecision | null> => {
  if (config.aiPolicyMode === 'off') return null;

  const now = Date.now();
  const gate = canCallPolicyNow(now);
  if (!gate.ok) return null;

  const meta = getPolicyMeta();
  const nextMeta = { ...meta, lastAt: now, calls: meta.calls + 1 };

  if (!client) {
    const decision: AiPolicyDecision = {
      at: now,
      mode: config.aiPolicyMode,
      action: 'HOLD',
      confidence: 0.2,
      reason: 'OpenAI is not configured (OPENAI_API_KEY missing).',
      model: config.aiPolicyModel,
    };
    persistMeta(persisted, { aiPolicy: { ...nextMeta, lastDecision: decision } });
    return decision;
  }

  try {
    const [news, candidates] = await Promise.all([getNewsSentiment(), buildCandidates(seedSymbol)]);
    const openPositions = buildOpenPositions();

    const payload = {
      venue: config.tradeVenue,
      homeAsset: config.homeAsset,
      portfolioEnabled: config.portfolioEnabled,
      portfolioMaxPositions: config.portfolioMaxPositions,
      openPositions,
      candidates,
      newsSentiment: news.sentiment,
    };

    const completion = await client.chat.completions.create({
      model: config.aiPolicyModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt(payload) },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = decisionSchema.parse(JSON.parse(raw)) as z.infer<typeof decisionSchema>;

    const decision: AiPolicyDecision = {
      at: now,
      mode: config.aiPolicyMode,
      action: parsed.action,
      symbol: parsed.symbol?.toUpperCase(),
      horizon: parsed.horizon as Horizon | undefined,
      positionKey: parsed.positionKey,
      confidence: parsed.confidence,
      reason: parsed.reason,
      model: config.aiPolicyModel,
    };

    persistMeta(persisted, { aiPolicy: { ...nextMeta, lastDecision: decision } });
    return decision;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'AI policy call failed');
    const decision: AiPolicyDecision = {
      at: now,
      mode: config.aiPolicyMode,
      action: 'HOLD',
      confidence: 0.3,
      reason: `AI policy error: ${errorToString(error)}`.slice(0, 400),
      model: config.aiPolicyModel,
    };
    persistMeta(persisted, { aiPolicy: { ...nextMeta, lastDecision: decision } });
    return decision;
  }
};
