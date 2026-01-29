import OpenAI from 'openai';
import { z } from 'zod';

import { get24hStats, getBalances } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AiPolicyDecision, AiPolicyTuning, Balance, Horizon } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistMeta } from './persistence.js';

const persisted = getPersistedState();
const client = config.openAiApiKey
  ? new OpenAI({ apiKey: config.openAiApiKey, baseURL: config.openAiBaseUrl || undefined })
  : null;

const todayKey = () => new Date().toISOString().slice(0, 10);

const tuneSchema = z
  .object({
    minQuoteVolume: z.number().min(100_000).max(200_000_000).optional(),
    maxVolatilityPercent: z.number().min(2).max(60).optional(),
    autoTradeHorizon: z.enum(['short', 'medium', 'long']).optional(),
    portfolioMaxAllocPct: z.number().min(1).max(95).optional(),
    portfolioMaxPositions: z.number().int().min(1).max(15).optional(),
    gridMaxAllocPct: z.number().min(0).max(80).optional(),
  })
  .strict()
  .optional();

const decisionSchema = z.object({
  action: z.enum(['HOLD', 'OPEN', 'CLOSE', 'PANIC', 'PAUSE_GRID', 'RESUME_GRID', 'REDUCE_RISK']),
  symbol: z.string().min(3).max(20).optional(),
  horizon: z.enum(['short', 'medium', 'long']).optional(),
  positionKey: z.string().min(3).max(64).optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(400),
  tune: tuneSchema,
  sweepUnusedToHome: z.boolean().optional(),
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
- action: one of HOLD | OPEN | CLOSE | PANIC | PAUSE_GRID | RESUME_GRID | REDUCE_RISK
- symbol?: string
    - required when action=OPEN (must be one of the provided candidates)
    - required when action=PAUSE_GRID or RESUME_GRID (must match a running grid symbol)
- horizon?: short|medium|long (required when action=OPEN)
- positionKey?: string (required when action=CLOSE; must match exactly one provided open position key)
- confidence: number 0..1
- reason: short string (<= 400 chars)
- tune?: optional object with any of:
    - minQuoteVolume (number)
    - maxVolatilityPercent (number)
    - autoTradeHorizon (short|medium|long)
    - portfolioMaxAllocPct (number)
    - portfolioMaxPositions (integer)
    - gridMaxAllocPct (number)
- sweepUnusedToHome?: boolean (only if unusedAssets are non-empty)

Hard rules:
- NEVER invent symbols or positionKey. Choose ONLY from the provided lists.
- NEVER invent config keys. If proposing tune, use ONLY the allowed keys and keep values within provided bounds.
- If you are uncertain, choose HOLD.
- Prefer risk control over activity.`;

const summarizeBalances = (balances: Balance[], max = 12) => {
  const rows = balances
    .map((b) => ({ asset: b.asset.toUpperCase(), free: b.free ?? 0, locked: b.locked ?? 0 }))
    .filter((b) => Number.isFinite(b.free) && Number.isFinite(b.locked) && b.free + b.locked > 0)
    .sort((a, b) => b.locked - a.locked || b.free - a.free)
    .slice(0, Math.max(1, max));
  return rows;
};

const computeProtectedAssets = (homeAsset: string) => {
  const protectedAssets = new Set<string>([homeAsset.toUpperCase()]);
  for (const asset of config.allowedQuoteAssets) protectedAssets.add(asset.toUpperCase());
  protectedAssets.add(config.quoteAsset.toUpperCase());
  for (const pos of Object.values(persisted.positions)) {
    if (!pos) continue;
    if ((pos.venue ?? 'spot') !== 'spot') continue;
    if (pos.baseAsset) protectedAssets.add(pos.baseAsset.toUpperCase());
    if (pos.quoteAsset) protectedAssets.add(pos.quoteAsset.toUpperCase());
    if (pos.homeAsset) protectedAssets.add(pos.homeAsset.toUpperCase());
  }
  return protectedAssets;
};

const userPrompt = (payload: {
  venue: string;
  homeAsset: string;
  portfolioEnabled: boolean;
  portfolioMaxPositions: number;
  grid?: {
    enabled: boolean;
    maxAllocPct: number;
    maxActiveGrids: number;
    running: Array<{
      symbol: string;
      allocationHome: number;
      orderNotionalHome: number;
      lowerPrice: number;
      upperPrice: number;
      levels: number;
      createdAt: number;
      status: string;
      pnlHome?: number;
      pnlPct?: number;
      feesHome?: number;
      fillsBuy?: number;
      fillsSell?: number;
      breakouts?: number;
      lastError?: string;
    }>;
    recentStopped: Array<{
      symbol: string;
      status: string;
      updatedAt: number;
      pnlHome?: number;
      pnlPct?: number;
      breakouts?: number;
      lastError?: string;
    }>;
  };
  openPositions: ReturnType<typeof buildOpenPositions>;
  candidates: Awaited<ReturnType<typeof buildCandidates>>;
  newsSentiment: number;
  tunables: {
    current: AiPolicyTuning;
    bounds: Record<string, { min: number; max: number }>;
  };
  balanceSummary?: ReturnType<typeof summarizeBalances>;
  unusedAssets?: string[];
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

    let balanceSummary: ReturnType<typeof summarizeBalances> | undefined = undefined;
    let unusedAssets: string[] | undefined = undefined;
    if (config.tradeVenue === 'spot') {
      try {
        const balances = await getBalances();
        balanceSummary = summarizeBalances(balances);
        const protectedAssets = computeProtectedAssets(config.homeAsset.toUpperCase());
        const unused = balances
          .filter((b) => (b.free ?? 0) > 0)
          .map((b) => b.asset.toUpperCase())
          .filter((a) => !protectedAssets.has(a))
          .sort();
        unusedAssets = unused.slice(0, 20);
      } catch {
        // ignore
      }
    }

    const grids = Object.values(persisted.grids ?? {});
    const gridPayload =
      config.tradeVenue === 'spot'
        ? {
            enabled: config.gridEnabled,
            maxAllocPct: config.gridMaxAllocPct,
            maxActiveGrids: config.gridMaxActiveGrids,
            running: grids
              .filter((g) => g?.status === 'running')
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              .slice(0, 5)
              .map((g) => ({
                symbol: g.symbol.toUpperCase(),
                allocationHome: g.allocationHome ?? 0,
                orderNotionalHome: g.orderNotionalHome ?? 0,
                lowerPrice: g.lowerPrice ?? 0,
                upperPrice: g.upperPrice ?? 0,
                levels: g.levels ?? 0,
                createdAt: g.createdAt ?? 0,
                status: g.status,
                pnlHome: g.performance?.pnlHome,
                pnlPct: g.performance?.pnlPct,
                feesHome: g.performance?.feesHome,
                fillsBuy: g.performance?.fillsBuy,
                fillsSell: g.performance?.fillsSell,
                breakouts: g.performance?.breakouts,
                lastError: g.lastError,
              })),
            recentStopped: grids
              .filter((g) => g && g.status !== 'running')
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              .slice(0, 5)
              .map((g) => ({
                symbol: g.symbol.toUpperCase(),
                status: g.status,
                updatedAt: g.updatedAt ?? 0,
                pnlHome: g.performance?.pnlHome,
                pnlPct: g.performance?.pnlPct,
                breakouts: g.performance?.breakouts,
                lastError: g.lastError,
              })),
          }
        : undefined;

    const payload = {
      venue: config.tradeVenue,
      homeAsset: config.homeAsset,
      portfolioEnabled: config.portfolioEnabled,
      portfolioMaxPositions: config.portfolioMaxPositions,
      grid: gridPayload,
      openPositions,
      candidates,
      newsSentiment: news.sentiment,
      tunables: {
        current: {
          minQuoteVolume: config.minQuoteVolume,
          maxVolatilityPercent: config.maxVolatilityPercent,
          autoTradeHorizon: config.autoTradeHorizon,
          portfolioMaxAllocPct: config.portfolioMaxAllocPct,
          portfolioMaxPositions: config.portfolioMaxPositions,
          gridMaxAllocPct: config.gridMaxAllocPct,
        },
        bounds: {
          minQuoteVolume: { min: 100_000, max: 200_000_000 },
          maxVolatilityPercent: { min: 2, max: 60 },
          portfolioMaxAllocPct: { min: 1, max: 95 },
          portfolioMaxPositions: { min: 1, max: 15 },
          gridMaxAllocPct: { min: 0, max: 80 },
        },
      },
      balanceSummary,
      unusedAssets,
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
      tune: parsed.tune as AiPolicyTuning | undefined,
      sweepUnusedToHome: parsed.sweepUnusedToHome,
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
