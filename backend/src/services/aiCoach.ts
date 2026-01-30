import { z } from 'zod';

import { get24hStats, getLatestPrice } from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AiCoachProposal, AiCoachProposalRecord, AiCoachSnapshot, AiPolicyTuning, RiskGovernorState } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { resolveAutonomy } from './aiAutonomy.js';
import { applyAiTuning } from './aiTuning.js';
import { pauseGridBuys, resumeGridBuys, startGrid, stopGrid } from './gridTrader.js';
import { getNewsSentiment } from './newsService.js';
import { getPersistedState, persistMeta } from './persistence.js';
import { getPnlReconcile,persistAiCoachLog } from './sqlite.js';
import { addAutoBlacklistSymbol } from './symbolPolicy.js';

import { callJson } from '../ai/jsonCall.js';

const persisted = getPersistedState();
// OpenAI client is provided by backend/src/ai/openai.ts via callJson().

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

const stableUsdAssets = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'USDD']);

const estimateHomeToUsdRate = async (homeAsset: string): Promise<number | null> => {
  const home = (homeAsset ?? '').toUpperCase();
  if (!home) return null;
  if (stableUsdAssets.has(home)) return 1;

  const direct = `${home}USDT`;
  try {
    const p = await getLatestPrice(direct);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    // ignore
  }

  const inverse = `USDT${home}`;
  try {
    const p = await getLatestPrice(inverse);
    if (Number.isFinite(p) && p > 0) return 1 / p;
  } catch {
    // ignore
  }

  return null;
};

const clampToEnvelope = (tune: AiPolicyTuning): AiPolicyTuning => {
  const env = config.aiTuningEnvelope;
  const next: AiPolicyTuning = {};

  if (tune.minQuoteVolume !== undefined && Number.isFinite(tune.minQuoteVolume)) {
    next.minQuoteVolume = Math.min(env.minQuoteVolume.max, Math.max(env.minQuoteVolume.min, Math.floor(tune.minQuoteVolume)));
  }
  if (tune.maxVolatilityPercent !== undefined && Number.isFinite(tune.maxVolatilityPercent)) {
    next.maxVolatilityPercent = Math.min(env.maxVolatilityPercent.max, Math.max(env.maxVolatilityPercent.min, tune.maxVolatilityPercent));
  }
  if (tune.riskPerTradeBasisPoints !== undefined && Number.isFinite(tune.riskPerTradeBasisPoints)) {
    next.riskPerTradeBasisPoints = Math.min(
      env.riskPerTradeBasisPoints.max,
      Math.max(env.riskPerTradeBasisPoints.min, tune.riskPerTradeBasisPoints),
    );
  }
  if (tune.portfolioMaxPositions !== undefined && Number.isFinite(tune.portfolioMaxPositions)) {
    next.portfolioMaxPositions = Math.min(
      env.portfolioMaxPositions.max,
      Math.max(env.portfolioMaxPositions.min, Math.floor(tune.portfolioMaxPositions)),
    );
  }
  if (tune.gridMaxAllocPct !== undefined && Number.isFinite(tune.gridMaxAllocPct)) {
    next.gridMaxAllocPct = Math.min(env.gridMaxAllocPct.max, Math.max(env.gridMaxAllocPct.min, tune.gridMaxAllocPct));
  }

  return next;
};

const classifyTuning = (tune: AiPolicyTuning) => {
  const current = {
    minQuoteVolume: config.minQuoteVolume,
    maxVolatilityPercent: config.maxVolatilityPercent,
    riskPerTradeBasisPoints: config.riskPerTradeBasisPoints,
    portfolioMaxPositions: config.portfolioMaxPositions,
    gridMaxAllocPct: config.gridMaxAllocPct,
  };

  const tighten: AiPolicyTuning = {};
  const relax: AiPolicyTuning = {};

  if (tune.minQuoteVolume !== undefined && Number.isFinite(tune.minQuoteVolume) && tune.minQuoteVolume !== current.minQuoteVolume) {
    if (tune.minQuoteVolume >= current.minQuoteVolume) tighten.minQuoteVolume = tune.minQuoteVolume;
    else relax.minQuoteVolume = tune.minQuoteVolume;
  }
  if (
    tune.maxVolatilityPercent !== undefined &&
    Number.isFinite(tune.maxVolatilityPercent) &&
    tune.maxVolatilityPercent !== current.maxVolatilityPercent
  ) {
    if (tune.maxVolatilityPercent <= current.maxVolatilityPercent) tighten.maxVolatilityPercent = tune.maxVolatilityPercent;
    else relax.maxVolatilityPercent = tune.maxVolatilityPercent;
  }
  if (
    tune.riskPerTradeBasisPoints !== undefined &&
    Number.isFinite(tune.riskPerTradeBasisPoints) &&
    tune.riskPerTradeBasisPoints !== current.riskPerTradeBasisPoints
  ) {
    if (tune.riskPerTradeBasisPoints <= current.riskPerTradeBasisPoints) tighten.riskPerTradeBasisPoints = tune.riskPerTradeBasisPoints;
    else relax.riskPerTradeBasisPoints = tune.riskPerTradeBasisPoints;
  }
  if (
    tune.portfolioMaxPositions !== undefined &&
    Number.isFinite(tune.portfolioMaxPositions) &&
    tune.portfolioMaxPositions !== current.portfolioMaxPositions
  ) {
    if (tune.portfolioMaxPositions <= current.portfolioMaxPositions) tighten.portfolioMaxPositions = tune.portfolioMaxPositions;
    else relax.portfolioMaxPositions = tune.portfolioMaxPositions;
  }
  if (tune.gridMaxAllocPct !== undefined && Number.isFinite(tune.gridMaxAllocPct) && tune.gridMaxAllocPct !== current.gridMaxAllocPct) {
    if (tune.gridMaxAllocPct <= current.gridMaxAllocPct) tighten.gridMaxAllocPct = tune.gridMaxAllocPct;
    else relax.gridMaxAllocPct = tune.gridMaxAllocPct;
  }

  return { tighten, relax };
};

const tuneSchema = z
  .object({
    minQuoteVolume: z.number().min(100_000).max(200_000_000).optional(),
    maxVolatilityPercent: z.number().min(2).max(60).optional(),
    riskPerTradeBasisPoints: z.number().min(1).max(200).optional(),
    portfolioMaxPositions: z.number().int().min(1).max(15).optional(),
    gridMaxAllocPct: z.number().min(0).max(80).optional(),
  })
  .strict();

const proposalSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('TUNING_UPDATE'),
      changes: tuneSchema,
      reason: z.string().min(1).max(600),
    })
    .strict(),
  z
    .object({
      type: z.literal('SYMBOL_POLICY'),
      whitelistAdd: z.array(z.string().min(2).max(30)).max(50).optional(),
      blacklistAdd: z
        .array(
          z
            .object({
              symbol: z.string().min(2).max(30),
              ttlMinutes: z.number().int().min(15).max(10_080),
              reason: z.string().min(1).max(400),
            })
            .strict(),
        )
        .max(25)
        .optional(),
      reason: z.string().min(1).max(600).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('GRID_ACTION'),
      symbol: z.string().min(2).max(30),
      action: z.enum(['PAUSE_BUYS', 'RESUME_BUYS', 'STOP_GRID', 'START_GRID']),
      reason: z.string().min(1).max(400),
    })
    .strict(),
]);

const coachSchema = z
  .object({
    proposals: z.array(proposalSchema).max(12),
    confidence: z.number().min(0).max(1),
    notes: z.array(z.string().min(1).max(400)).max(12).optional(),
  })
  .strict();

const systemPrompt = `You are an AI Coach for a crypto trading bot.
Return ONLY a single JSON object with this schema:
{
  "proposals": [
    {
      "type": "TUNING_UPDATE",
      "changes": {
        "minQuoteVolume"?: number,
        "maxVolatilityPercent"?: number,
        "riskPerTradeBasisPoints"?: number,
        "portfolioMaxPositions"?: number,
        "gridMaxAllocPct"?: number
      },
      "reason": "..."
    },
    {
      "type": "SYMBOL_POLICY",
      "whitelistAdd"?: ["..."],
      "blacklistAdd"?: [{"symbol":"...","ttlMinutes":360,"reason":"..."}],
      "reason"?: "..."
    },
    {
      "type": "GRID_ACTION",
      "symbol": "...",
      "action": "PAUSE_BUYS" | "RESUME_BUYS" | "STOP_GRID" | "START_GRID",
      "reason": "..."
    }
  ],
  "confidence": 0..1,
  "notes"?: ["..."]
}

Hard safety rules (never violate):
- Never propose changing TRADING_ENABLED, API keys, exchange base URLs, or disabling emergency stop / loss caps.
- Propose tuning changes ONLY within the given envelope ranges.
- Only use the tuning keys listed above (no extra keys).
- Prefer risk reduction over activity when uncertain.
- Do not spam proposals; pick the highest-impact items.`;

const buildUserPrompt = (payload: unknown) => `Context (compact JSON):
${JSON.stringify(payload, null, 2)}

Now return coach output JSON.`;

const currentGovernorState = (): RiskGovernorState | null => persisted.meta?.riskGovernor?.decision?.state ?? null;

const buildCoachContext = async (now: number) => {
  const governor = persisted.meta?.riskGovernor?.decision ?? null;

  const eqHome =
    persisted.meta?.riskGovernor?.lastEquityHome ??
    persisted.meta?.equity?.lastHome ??
    null;
  const homeAsset = (persisted.meta?.riskGovernor?.homeAsset ?? persisted.meta?.equity?.homeAsset ?? config.homeAsset).toUpperCase();

  const rate = Number.isFinite(eqHome ?? NaN) && eqHome !== null && eqHome > 0 ? await estimateHomeToUsdRate(homeAsset) : null;
  const equityUsd = eqHome !== null && Number.isFinite(eqHome) && eqHome > 0 ? eqHome * (rate ?? 1) : null;

  const pnl6h = await getPnlReconcile('6h');
  const pnl24h = await getPnlReconcile('24h');

  const feesHome = pnl24h.feesHomeTotal ?? null;
  const equityNow = pnl24h.equityNow ?? null;
  const feeBurn = feesHome !== null && equityNow !== null && equityNow > 0 ? feesHome / equityNow : null;

  const candidatesSeed = (persisted.meta?.rankedCandidates ?? []).slice(0, 10);
  const candidateSymbols =
    candidatesSeed.length > 0
      ? candidatesSeed.map((c) => c.symbol.toUpperCase())
      : config.tradeUniverse.length > 0
        ? config.tradeUniverse.slice(0, 10).map((s) => s.toUpperCase())
        : [config.defaultSymbol.toUpperCase()];

  const candidateStats = await Promise.all(
    candidateSymbols.map(async (symbol) => {
      try {
        const snap = await get24hStats(symbol);
        const volPct = Math.abs((snap.highPrice - snap.lowPrice) / Math.max(snap.price, 0.00000001)) * 100;
        const score = candidatesSeed.find((c) => c.symbol.toUpperCase() === symbol)?.score;
        return {
          symbol,
          score: score ?? null,
          priceChangePercent: snap.priceChangePercent,
          quoteVolume: snap.quoteVolume ?? null,
          volatilityPct: Number.isFinite(volPct) ? volPct : null,
        };
      } catch {
        const score = candidatesSeed.find((c) => c.symbol.toUpperCase() === symbol)?.score;
        return { symbol, score: score ?? null, priceChangePercent: null, quoteVolume: null, volatilityPct: null };
      }
    }),
  );

  const grids = Object.values(persisted.grids ?? {})
    .filter(Boolean)
    .slice(0, 12)
    .map((g) => ({
      symbol: g.symbol.toUpperCase(),
      status: g.status,
      buyPaused: g.buyPaused === true,
      buyPauseReason: g.buyPauseReason ?? null,
      allocationHome: g.allocationHome ?? 0,
      baseVirtual: g.performance?.baseVirtual ?? null,
      quoteVirtual: g.performance?.quoteVirtual ?? null,
      pnlHome: g.performance?.pnlHome ?? null,
      pnlPct: g.performance?.pnlPct ?? null,
      lastError: g.lastError ?? null,
    }));

  const news = await getNewsSentiment();

  return {
    at: now,
    safety: {
      tradingEnabled: config.tradingEnabled,
      autoTradeEnabled: config.autoTradeEnabled,
      emergencyStop: persisted.meta?.emergencyStop ?? false,
      tradeHalted: false, // derived by strategy endpoints; coach keeps conservative
      dailyLossCapPct: config.dailyLossCapPct,
    },
    universe: {
      mode: config.tradeUniverse.length > 0 ? 'static' : 'discovery',
      tradeUniverse: config.tradeUniverse.slice(0, 80),
      tradeDenylist: config.tradeDenylist.slice(0, 80),
      accountDenylist: Object.keys(persisted.meta?.accountBlacklist ?? {})
        .map((s) => s.toUpperCase())
        .slice(0, 80),
      autoBlacklist: Object.entries(persisted.meta?.autoBlacklist ?? {})
        .map(([symbol, entry]) => ({
          symbol: symbol.toUpperCase(),
          bannedUntil: entry.bannedUntil ?? 0,
          reason: entry.reason ?? 'auto_blacklist',
        }))
        .filter((e) => typeof e.bannedUntil === 'number' && e.bannedUntil > now)
        .slice(0, 80),
      top10: candidateStats,
    },
    autonomy: {
      profile: config.aiAutonomyProfile,
      envelope: config.aiTuningEnvelope,
      allowRiskRelaxationEnv: config.aiPolicyAllowRiskRelaxation,
    },
    governor: governor
      ? {
          state: governor.state,
          entriesPaused: governor.entriesPaused,
          gridBuyPausedGlobal: governor.gridBuyPausedGlobal,
          reasons: governor.reasons?.slice(0, 6) ?? [],
        }
      : null,
    equity: {
      homeAsset,
      equityHome: eqHome,
      equityUsd: equityUsd,
      homeToUsdRate: rate,
      minEquityUsd: config.aiCoachMinEquityUsd,
    },
    pnl: {
      window6h: {
        equityChange: pnl6h.equityChange,
        feesHomeTotal: pnl6h.feesHomeTotal,
        residual: pnl6h.residual,
        notes: pnl6h.notes?.slice(0, 3),
      },
      window24h: {
        equityChange: pnl24h.equityChange,
        feesHomeTotal: pnl24h.feesHomeTotal,
        residual: pnl24h.residual,
        notes: pnl24h.notes?.slice(0, 3),
      },
      feeBurnFraction24h: feeBurn,
    },
    tuning: {
      current: {
        minQuoteVolume: config.minQuoteVolume,
        maxVolatilityPercent: config.maxVolatilityPercent,
        riskPerTradeBasisPoints: config.riskPerTradeBasisPoints,
        portfolioMaxPositions: config.portfolioMaxPositions,
        gridMaxAllocPct: config.gridMaxAllocPct,
      },
      runtimeOverrides: persisted.meta?.runtimeConfig ?? null,
    },
    grids,
    news: { sentiment: news.sentiment, headlines: news.headlines.slice(0, 6) },
  };
};

const shouldSkipCoach = async () => {
  const eqHome = persisted.meta?.riskGovernor?.lastEquityHome ?? persisted.meta?.equity?.lastHome ?? null;
  const homeAsset = (persisted.meta?.riskGovernor?.homeAsset ?? persisted.meta?.equity?.homeAsset ?? config.homeAsset).toUpperCase();
  if (eqHome === null || !Number.isFinite(eqHome) || eqHome <= 0) return { skip: false, reason: null as string | null };
  const rate = await estimateHomeToUsdRate(homeAsset);
  const equityUsd = eqHome * (rate ?? 1);
  if (equityUsd < config.aiCoachMinEquityUsd) {
    return { skip: true, reason: `Equity below minimum (${equityUsd.toFixed(2)} < ${config.aiCoachMinEquityUsd}).` };
  }
  return { skip: false, reason: null as string | null };
};

export const runAiCoachOnce = async (): Promise<AiCoachSnapshot> => {
  const now = Date.now();
  const governorState = currentGovernorState();

  const envFlags = {
    aiPolicyAllowRiskRelaxation: config.aiPolicyAllowRiskRelaxation,
    aiPolicySweepAutoApply: config.aiPolicySweepAutoApply,
    autoBlacklistEnabled: config.autoBlacklistEnabled,
  };

  const capabilities = resolveAutonomy(config.aiAutonomyProfile, envFlags, governorState);

  const baseSnapshot: AiCoachSnapshot = {
    at: now,
    profile: config.aiAutonomyProfile,
    governorState,
    confidence: 0,
    notes: undefined,
    model: config.aiPolicyModel,
    proposals: [],
  };

  if (!config.aiCoachEnabled) {
    const snap: AiCoachSnapshot = { ...baseSnapshot, skipped: true, skipReason: 'AI_COACH_ENABLED=false' };
    persistMeta(persisted, { latestCoach: snap });
    persistAiCoachLog({ at: now, profile: snap.profile, governorState, confidence: snap.confidence, proposals: [], applied: [], notes: ['disabled'], model: snap.model });
    return snap;
  }

  const skip = await shouldSkipCoach();
  if (skip.skip) {
    const snap: AiCoachSnapshot = { ...baseSnapshot, skipped: true, skipReason: skip.reason ?? 'below_min_equity' };
    persistMeta(persisted, { latestCoach: snap });
    persistAiCoachLog({ at: now, profile: snap.profile, governorState, confidence: snap.confidence, proposals: [], applied: [], notes: ['skipped'], model: snap.model });
    return snap;
  }

  if (!config.aiApiKey) {
    const snap: AiCoachSnapshot = {
      ...baseSnapshot,
      skipped: true,
      skipReason: 'AI not configured (AI_API_KEY missing).',
      notes: ['Set AI_API_KEY to enable AI Coach.'],
    };
    persistMeta(persisted, { latestCoach: snap });
    persistAiCoachLog({ at: now, profile: snap.profile, governorState, confidence: snap.confidence, proposals: [], applied: [], notes: snap.notes, model: snap.model });
    return snap;
  }

  try {
    const ctx = await buildCoachContext(now);

    const res = await callJson({
      schema: coachSchema,
      model: config.aiPolicyModel,
      temperature: 0.2,
      timeoutMs: 90_000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(ctx) },
      ],
    });

    if (!res.ok) {
      throw new Error(res.error);
    }

    const parsed = res.data as z.infer<typeof coachSchema>;

    const proposalRecords: AiCoachProposalRecord[] = [];

    const emergencyStop = persisted.meta?.emergencyStop ?? false;
    const isGovernorNormal = governorState === 'NORMAL' || governorState === null;

    for (const proposal of parsed.proposals as unknown as AiCoachProposal[]) {
      const record: AiCoachProposalRecord = { proposal, applied: { applied: false } };

      if (proposal.type === 'TUNING_UPDATE') {
        const clamped = clampToEnvelope(proposal.changes ?? {});
        const { tighten, relax } = classifyTuning(clamped);

        const appliedParts: { tighten?: unknown; relax?: unknown } = {};
        const errors: string[] = [];

        if (capabilities.canAutoApplyTuningTighten && Object.keys(tighten).length > 0) {
          const res = applyAiTuning({ tune: tighten, source: 'ai', reason: `ai-coach:tighten:${proposal.reason}`.slice(0, 180) });
          if (res.ok) appliedParts.tighten = res.applied ?? res.wouldApply ?? null;
          else errors.push(res.error);
        }

        const canRelaxNow =
          capabilities.canAutoApplyTuningRelax && !emergencyStop && isGovernorNormal;
        if (canRelaxNow && Object.keys(relax).length > 0) {
          const res = applyAiTuning({ tune: relax, source: 'ai', reason: `ai-coach:relax:${proposal.reason}`.slice(0, 180) });
          if (res.ok) appliedParts.relax = res.applied ?? res.wouldApply ?? null;
          else errors.push(res.error);
        }

        const appliedAny = Object.keys(appliedParts).length > 0;
        record.applied = appliedAny
          ? { applied: true, ok: errors.length === 0, error: errors.length ? errors.join(' | ') : undefined, result: appliedParts }
          : { applied: false, ok: true, result: { tightenSuggested: tighten, relaxSuggested: relax } };
      }

      if (proposal.type === 'GRID_ACTION') {
        const symbol = proposal.symbol.toUpperCase();
        const action = proposal.action;

        const isRelaxAction = action === 'RESUME_BUYS' || action === 'START_GRID';
        if (emergencyStop && isRelaxAction) {
          record.applied = { applied: false, ok: true, error: 'Blocked: emergency stop enabled' };
          proposalRecords.push(record);
          continue;
        }

        if (action === 'PAUSE_BUYS') {
          if (!capabilities.canPauseGrid) {
            record.applied = { applied: false, ok: true, error: 'Blocked by autonomy profile' };
          } else {
            const res = await pauseGridBuys(symbol, { reason: 'ai-coach' });
            record.applied = res.ok ? { applied: true, ok: true } : { applied: false, ok: false, error: res.error };
          }
        } else if (action === 'RESUME_BUYS') {
          if (!capabilities.canResumeGrid || !isGovernorNormal) {
            record.applied = { applied: false, ok: true, error: 'Blocked: governor not NORMAL or risk relaxation disabled' };
          } else {
            const res = await resumeGridBuys(symbol);
            record.applied = res.ok ? { applied: true, ok: true } : { applied: false, ok: false, error: res.error };
          }
        } else if (action === 'STOP_GRID') {
          if (config.aiAutonomyProfile === 'safe') {
            record.applied = { applied: false, ok: true, error: 'Blocked by autonomy profile' };
          } else {
            const res = await stopGrid(symbol);
            record.applied = res.ok ? { applied: true, ok: true } : { applied: false, ok: false, error: res.error };
          }
        } else if (action === 'START_GRID') {
          const allowStart =
            config.aiAutonomyProfile === 'aggressive' && capabilities.canResumeGrid && isGovernorNormal && config.aiPolicyAllowRiskRelaxation;
          if (!allowStart) {
            record.applied = { applied: false, ok: true, error: 'Blocked by autonomy profile / env allow / governor' };
          } else if (!config.tradingEnabled) {
            record.applied = { applied: false, ok: true, error: 'Blocked: TRADING_ENABLED=false' };
          } else {
            const res = await startGrid(symbol);
            record.applied = res.ok ? { applied: true, ok: true } : { applied: false, ok: false, error: res.error };
          }
        }
      }

      if (proposal.type === 'SYMBOL_POLICY') {
        const changes: { applied: Array<{ symbol: string; bannedUntil: number; ttlMinutes: number }>; skipped: Array<{ symbol: string; reason: string }> } = {
          applied: [],
          skipped: [],
        };

        if (!capabilities.canAutoBlacklistSymbols) {
          record.applied = { applied: false, ok: true, error: 'Blocked by autonomy profile' };
          proposalRecords.push(record);
          continue;
        }

        const blacklistAdd = proposal.blacklistAdd ?? [];
        for (const entry of blacklistAdd) {
          const res = addAutoBlacklistSymbol({
            symbol: entry.symbol,
            ttlMinutes: entry.ttlMinutes,
            reason: entry.reason,
            source: 'ai-coach',
          });
          if (res.ok) {
            changes.applied.push({ symbol: entry.symbol.toUpperCase(), bannedUntil: res.entry.bannedUntil, ttlMinutes: res.entry.ttlMinutes });
          } else {
            changes.skipped.push({ symbol: entry.symbol.toUpperCase(), reason: res.error });
          }
        }

        record.applied =
          changes.applied.length > 0
            ? { applied: true, ok: changes.skipped.length === 0, error: changes.skipped.length ? JSON.stringify(changes.skipped).slice(0, 240) : undefined, result: changes }
            : { applied: false, ok: true, result: changes };
      }

      proposalRecords.push(record);
    }

    const snapshot: AiCoachSnapshot = {
      at: now,
      profile: config.aiAutonomyProfile,
      governorState,
      confidence: parsed.confidence,
      notes: parsed.notes?.length ? parsed.notes : undefined,
      model: config.aiPolicyModel,
      proposals: proposalRecords,
    };

    persistMeta(persisted, { latestCoach: snapshot });
    persistAiCoachLog({
      at: now,
      profile: snapshot.profile,
      governorState,
      confidence: snapshot.confidence,
      proposals: parsed.proposals as unknown as AiCoachProposal[],
      applied: proposalRecords,
      notes: snapshot.notes,
      model: snapshot.model,
    });

    if (snapshot.proposals.length > 0) {
      logger.info(
        { proposals: snapshot.proposals.length, applied: snapshot.proposals.filter((p) => p.applied.applied).length, confidence: snapshot.confidence },
        'AI coach proposals updated',
      );
    }

    return snapshot;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'AI coach call failed');
    const snap: AiCoachSnapshot = {
      ...baseSnapshot,
      skipped: true,
      skipReason: `AI coach error: ${errorToString(error)}`.slice(0, 240),
      notes: [`AI coach error: ${errorToString(error)}`.slice(0, 240)],
    };
    persistMeta(persisted, { latestCoach: snap });
    persistAiCoachLog({ at: now, profile: snap.profile, governorState, confidence: 0, proposals: [], applied: [], notes: snap.notes, model: snap.model });
    return snap;
  }
};

export const startAiCoach = () => {
  if (timer) return;
  if (!config.aiCoachEnabled) return;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runAiCoachOnce();
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'AI coach tick failed');
    } finally {
      inFlight = false;
    }
  };

  void tick();
  timer = setInterval(tick, Math.max(60, config.aiCoachIntervalSeconds) * 1000);
  logger.info({ intervalSeconds: config.aiCoachIntervalSeconds, profile: config.aiAutonomyProfile }, 'AI coach scheduler started');
};

export const stopAiCoach = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
