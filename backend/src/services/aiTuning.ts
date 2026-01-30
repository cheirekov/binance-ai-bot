import { applyRuntimeConfigOverrides, config } from '../config.js';
import { logger } from '../logger.js';
import { AiPolicyTuning, PersistedPayload } from '../types.js';
import { getPersistedState, persistMeta } from './persistence.js';

const persisted = getPersistedState();

const todayKey = () => new Date().toISOString().slice(0, 10);

const getAiTuningMeta = (): NonNullable<NonNullable<PersistedPayload['meta']>['aiTuning']> => {
  const meta = persisted.meta?.aiTuning;
  const today = todayKey();
  if (!meta || meta.date !== today) return { date: today, gridMaxAllocIncreasePct: 0, lastAt: undefined };
  return meta;
};

const clampGridAllocIncrease = (
  requested: number,
): { value: number | null; deltaApplied: number; note?: string } => {
  const current = config.gridMaxAllocPct;
  if (!Number.isFinite(requested)) return { value: null, deltaApplied: 0 };

  // Decreases are always allowed (risk-off).
  if (requested <= current) return { value: requested, deltaApplied: 0 };

  const capPerDay = Math.max(0, config.aiPolicyMaxGridAllocIncreasePctPerDay);
  const meta = getAiTuningMeta();
  const used = Math.max(0, meta.gridMaxAllocIncreasePct ?? 0);
  const remaining = Math.max(0, capPerDay - used);
  const desiredDelta = requested - current;
  const allowedDelta = Math.min(desiredDelta, remaining);

  if (allowedDelta <= 0) {
    return {
      value: null,
      deltaApplied: 0,
      note: `Grid alloc increase blocked: daily cap reached (${capPerDay}%/day).`,
    };
  }

  const value = current + allowedDelta;
  return {
    value,
    deltaApplied: allowedDelta,
    note: allowedDelta < desiredDelta ? `Grid alloc increase clamped to +${allowedDelta.toFixed(2)}% today.` : undefined,
  };
};

const clampToEnvelopeAiOnly = (tune: AiPolicyTuning, notes: string[]) => {
  const env = config.aiTuningEnvelope;
  const next: AiPolicyTuning = { ...tune };

  type NumericKey = 'minQuoteVolume' | 'maxVolatilityPercent' | 'riskPerTradeBasisPoints' | 'portfolioMaxPositions' | 'gridMaxAllocPct';

  const clamp = (key: NumericKey, min: number, max: number, map?: (v: number) => number) => {
    const raw = next[key];
    if (raw === undefined) return;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      delete next[key];
      return;
    }
    const val = typeof map === 'function' ? map(raw) : raw;
    const bounded = Math.min(max, Math.max(min, val));
    if (bounded !== raw) {
      notes.push(`AI tuning envelope clamp: ${String(key)} ${raw} → ${bounded}`);
    }
    (next as Record<string, unknown>)[key] = bounded;
  };

  clamp('minQuoteVolume', env.minQuoteVolume.min, env.minQuoteVolume.max, Math.floor);
  clamp('maxVolatilityPercent', env.maxVolatilityPercent.min, env.maxVolatilityPercent.max);
  clamp('riskPerTradeBasisPoints', env.riskPerTradeBasisPoints.min, env.riskPerTradeBasisPoints.max);
  clamp('portfolioMaxPositions', env.portfolioMaxPositions.min, env.portfolioMaxPositions.max, (v) => Math.floor(v));
  clamp('gridMaxAllocPct', env.gridMaxAllocPct.min, env.gridMaxAllocPct.max);

  return next;
};

export type ApplyAiTuningResult =
  | {
      ok: true;
      at: number;
      dryRun: boolean;
      requested: AiPolicyTuning;
      wouldApply?: ReturnType<typeof applyRuntimeConfigOverrides>;
      applied?: ReturnType<typeof applyRuntimeConfigOverrides>;
      notes?: string[];
    }
  | { ok: false; at: number; error: string };

export const applyAiTuning = (params: {
  tune: AiPolicyTuning;
  source: 'manual' | 'ai';
  reason: string;
  dryRun?: boolean;
}): ApplyAiTuningResult => {
  const now = Date.now();
  const tune = params.tune ?? {};
  if (!tune || Object.keys(tune).length === 0) {
    return { ok: false, at: now, error: 'No tuning values provided.' };
  }

  // First pass: bounds check / normalize.
  const bounded = applyRuntimeConfigOverrides({ ...tune }, { mutate: false });
  if (Object.keys(bounded).length === 0) {
    return { ok: false, at: now, error: 'Tuning values had no applicable changes (invalid or out of bounds).' };
  }

  const notes: string[] = [];
  let final: AiPolicyTuning = { ...bounded };

  // AI-only: clamp to the operator-defined tuning envelope (adds an extra safety boundary over absolute runtime bounds).
  if (params.source === 'ai') {
    final = clampToEnvelopeAiOnly(final, notes);
  }

  // Clamp daily increases for GRID_MAX_ALLOC_PCT (AI only).
  if (final.gridMaxAllocPct !== undefined) {
    const clamp = clampGridAllocIncrease(final.gridMaxAllocPct);
    if (clamp.note) notes.push(clamp.note);
    if (clamp.value === null) {
      delete final.gridMaxAllocPct;
    } else {
      final.gridMaxAllocPct = clamp.value;
    }
  }

  if (Object.keys(final).length === 0) {
    return { ok: false, at: now, error: 'Tuning was fully blocked by safety clamps.' };
  }

  if (params.dryRun) {
    const wouldApply = applyRuntimeConfigOverrides({ ...final }, { mutate: false });
    return { ok: true, at: now, dryRun: true, requested: tune, wouldApply, notes: notes.length ? notes : undefined };
  }

  const beforeGrid = config.gridMaxAllocPct;
  const applied = applyRuntimeConfigOverrides({ ...final }, { mutate: true });
  if (Object.keys(applied).length === 0) {
    return { ok: false, at: now, error: 'Tuning had no applicable changes after clamping.' };
  }

  persistMeta(persisted, {
    runtimeConfig: {
      updatedAt: now,
      source: params.source,
      reason: params.reason,
      values: applied,
    },
  });

  if (applied.gridMaxAllocPct !== undefined) {
    const delta = applied.gridMaxAllocPct - beforeGrid;
    if (delta > 0) {
      const meta = getAiTuningMeta();
      persistMeta(persisted, {
        aiTuning: {
          date: meta.date,
          gridMaxAllocIncreasePct: Math.max(0, (meta.gridMaxAllocIncreasePct ?? 0) + delta),
          lastAt: now,
        },
      });
    }
  }

  if (notes.length) {
    logger.info({ notes }, 'AI tuning safety clamps applied');
  }

  return { ok: true, at: now, dryRun: false, requested: tune, applied, notes: notes.length ? notes : undefined };
};
