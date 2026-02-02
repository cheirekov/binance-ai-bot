import { getBalances } from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { ensureAssetBalance } from './conversionRouter.js';
import { getPersistedState, persistMeta } from './persistence.js';
import { getRate } from './rates.js';

export type QuotePoolsTickResult =
  | {
      ok: true;
      summary: {
        enabled: boolean;
        homeAsset: string;
        equityHome?: number;
        targets: Array<{ asset: string; targetPct: number }>;
        topUpsAttempted: number;
        topUpsOk: number;
        skipped: Record<string, string>;
      };
    }
  | { ok: false; error: string };

type QuotePoolTarget = { asset: string; targetPct: number };

const persisted = getPersistedState();

const upper = (v: string) => v.trim().toUpperCase();

const clampNonNegative = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

const balanceFreeMap = (balances: Balance[]) => new Map(balances.map((b) => [upper(b.asset), clampNonNegative(b.free ?? 0)]));

const parseQuotePoolTargets = (raw: string | undefined): QuotePoolTarget[] => {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) return [];

  const targets: QuotePoolTarget[] = [];
  const seen = new Set<string>();

  for (const part of cleaned.split(',')) {
    const token = part.trim();
    if (!token) continue;

    const [assetRaw, pctRaw] = token.split(':').map((s) => s.trim());
    const asset = upper(assetRaw ?? '');
    if (!asset || !/^[A-Z0-9]{2,20}$/.test(asset)) continue;

    const pctNum = Number(pctRaw);
    if (!Number.isFinite(pctNum) || pctNum <= 0) continue;

    // Accept both fraction (0.10) and percent (10) formats.
    const targetPct = pctNum > 1 ? pctNum / 100 : pctNum;
    if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct >= 0.95) continue;

    if (seen.has(asset)) continue;
    seen.add(asset);

    targets.push({ asset, targetPct });
  }

  return targets;
};

const isBlockedForPoolRebalance = () => {
  const emergency = persisted.meta?.emergencyStop ?? false;
  if (emergency) return { blocked: true, reason: 'Emergency stop enabled' };

  const governorState = persisted.meta?.riskGovernor?.decision?.state ?? null;
  if (governorState === 'HALT') return { blocked: true, reason: 'Risk Governor HALT' };

  // Extra safety: quote pools tick runs BEFORE autoTradeTick (which enforces daily loss cap).
  // If equity telemetry is available, block pool conversions when the daily loss cap is already breached.
  const capPct = Math.abs(config.dailyLossCapPct ?? 0);
  const pnlPct = persisted.meta?.equity?.pnlPct;
  if (capPct > 0 && typeof pnlPct === 'number' && Number.isFinite(pnlPct) && pnlPct <= -capPct) {
    return { blocked: true, reason: `Daily loss cap breached (${pnlPct.toFixed(2)}% <= -${capPct.toFixed(2)}%)` };
  }

  return { blocked: false, reason: '' };
};

const getEquityHomeBestEffort = () => {
  const eq = persisted.meta?.riskGovernor?.lastEquityHome;
  return typeof eq === 'number' && Number.isFinite(eq) && eq > 0 ? eq : null;
};

export const quotePoolsTick = async (): Promise<QuotePoolsTickResult> => {
  const home = upper(config.homeAsset);

  const skipped: Record<string, string> = {};
  const targets = parseQuotePoolTargets(config.quotePoolTargetsRaw);

  if (!targets.length) {
    return {
      ok: true,
      summary: { enabled: false, homeAsset: home, targets: [], topUpsAttempted: 0, topUpsOk: 0, skipped: {} },
    };
  }

  if (config.tradeVenue !== 'spot') {
    return {
      ok: true,
      summary: { enabled: false, homeAsset: home, targets, topUpsAttempted: 0, topUpsOk: 0, skipped: { _global: 'Trade venue != spot' } },
    };
  }

  if (!config.tradingEnabled) {
    return {
      ok: true,
      summary: { enabled: false, homeAsset: home, targets, topUpsAttempted: 0, topUpsOk: 0, skipped: { _global: 'TRADING_ENABLED=false' } },
    };
  }

  if (!config.conversionEnabled) {
    return {
      ok: true,
      summary: { enabled: false, homeAsset: home, targets, topUpsAttempted: 0, topUpsOk: 0, skipped: { _global: 'CONVERSION_ENABLED=false' } },
    };
  }

  const blocked = isBlockedForPoolRebalance();
  if (blocked.blocked) {
    return {
      ok: true,
      summary: { enabled: true, homeAsset: home, targets, topUpsAttempted: 0, topUpsOk: 0, skipped: { _global: blocked.reason } },
    };
  }

  const equityHome = getEquityHomeBestEffort();
  if (!equityHome) {
    return {
      ok: true,
      summary: { enabled: true, homeAsset: home, targets, topUpsAttempted: 0, topUpsOk: 0, skipped: { _global: 'Equity unavailable (risk governor not initialized yet)' } },
    };
  }

  const excluded = new Set([
    ...(config.excludedAssets ?? []).map(upper),
    ...(config.excludedQuoteAssets ?? []).map(upper),
  ]);
  excluded.add(home);

  let balances: Balance[] = [];
  try {
    balances = await getBalances();
  } catch (error) {
    return { ok: false, error: `Failed to load balances: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }

  const freeBy = balanceFreeMap(balances);

  const thresholdBps = Math.max(0, config.quotePoolRebalanceBps);
  const thresholdPct = thresholdBps / 10_000;

  let topUpsAttempted = 0;
  let topUpsOk = 0;

  for (const t of targets) {
    const asset = upper(t.asset);
    if (!asset) continue;

    if (excluded.has(asset)) {
      skipped[asset] = 'Excluded by EXCLUDED_ASSETS/EXCLUDED_QUOTE_ASSETS/HOME';
      continue;
    }

    const targetPct = Math.max(0, Math.min(0.95, t.targetPct));
    const haveAsset = clampNonNegative(freeBy.get(asset) ?? 0);

    const rate = asset === home ? 1 : await getRate(asset, home);
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      skipped[asset] = `No rate ${asset}->${home}`;
      continue;
    }

    const haveHomeValue = haveAsset * rate;
    const havePct = equityHome > 0 ? haveHomeValue / equityHome : 0;

    // Conservative: only TOP-UP when below target by threshold. Never sell pools back into HOME.
    if (havePct >= targetPct - thresholdPct) {
      skipped[asset] = 'Within rebalance threshold';
      continue;
    }

    const desiredHomeValue = targetPct * equityHome;
    const desiredAsset = desiredHomeValue / rate;

    if (!Number.isFinite(desiredAsset) || desiredAsset <= 0) {
      skipped[asset] = 'Sizing failed';
      continue;
    }

    topUpsAttempted += 1;

    try {
      const res = await ensureAssetBalance(asset, desiredAsset, home);
      if (res.ok) {
        topUpsOk += 1;
        logger.info({ asset, targetPct: Number(targetPct.toFixed(4)) }, 'Quote pool top-up executed');
      } else {
        skipped[asset] = res.reason ?? 'Top-up failed';
      }
    } catch (error) {
      skipped[asset] = 'Top-up error';
      logger.warn({ err: errorToLogObject(error), asset }, 'Quote pool top-up failed');
    }
  }

  // Best-effort persistence for API/UI/debugging.
  try {
    persistMeta(persisted, {
      quotePools: {
        enabled: true,
        homeAsset: home,
        equityHome,
        targets,
        topUpsAttempted,
        topUpsOk,
        skipped,
        at: Date.now(),
      },
    } as unknown as Record<string, unknown>);
  } catch {
    // ignore
  }

  return {
    ok: true,
    summary: { enabled: true, homeAsset: home, equityHome, targets, topUpsAttempted, topUpsOk, skipped },
  };
};