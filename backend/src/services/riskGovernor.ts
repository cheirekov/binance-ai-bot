import { getBalances, getFuturesEquity, getLatestPrice } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config, feeRate } from '../config.js';
import { logger } from '../logger.js';
import { Balance, RiskGovernorDecision, RiskGovernorSnapshot, RiskGovernorState } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { fetchIndicatorSnapshot } from '../strategy/indicators.js';
import { getPersistedState, persistMeta } from './persistence.js';

const persisted = getPersistedState();

type EquityPoint = { at: number; equityHome: number };
type FeePoint = { at: number; feesHome: number; notionalHome: number; fills: number };

const pad2 = (n: number) => String(n).padStart(2, '0');

const localDayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const clampNonNegative = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);

const nowSeconds = (ts: number) => Math.floor(ts / 1000);

const withinMinutes = (now: number, at: number, minutes: number) => now - at <= Math.max(0, minutes) * 60_000;

const pushRing = <T extends { at: number }>(list: T[], item: T, maxMinutes: number) => {
  const now = item.at;
  const next = [...list, item].filter((p) => withinMinutes(now, p.at, maxMinutes));
  // Hard cap to avoid unbounded growth even if clock is weird.
  const hardCap = Math.max(32, Math.ceil(maxMinutes * 2)); // ~2 points/min at most.
  if (next.length > hardCap) return next.slice(next.length - hardCap);
  return next;
};

const percentDrawdown = (baseline: number, equityNow: number) => {
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  if (!Number.isFinite(equityNow) || equityNow <= 0) return 0;
  return ((baseline - equityNow) / baseline) * 100;
};

const balanceTotals = (balances: Balance[]) =>
  new Map(
    balances.map((b) => [
      b.asset.toUpperCase(),
      { free: b.free ?? 0, locked: b.locked ?? 0, total: (b.free ?? 0) + (b.locked ?? 0) },
    ]),
  );

const getAssetToAssetRate = async (
  symbols: Awaited<ReturnType<typeof fetchTradableSymbols>>,
  fromAsset: string,
  toAsset: string,
): Promise<number | null> => {
  const from = fromAsset.toUpperCase();
  const to = toAsset.toUpperCase();
  if (from === to) return 1;

  const direct = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
  );
  if (direct) {
    try {
      return await getLatestPrice(direct.symbol);
    } catch {
      return null;
    }
  }

  const inverse = symbols.find(
    (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
  );
  if (inverse) {
    try {
      const p = await getLatestPrice(inverse.symbol);
      return p > 0 ? 1 / p : null;
    } catch {
      return null;
    }
  }

  return null;
};

const getAssetToHomeRate = async (
  symbols: Awaited<ReturnType<typeof fetchTradableSymbols>>,
  asset: string,
  homeAsset: string,
): Promise<number | null> => {
  const a = asset.toUpperCase();
  const h = homeAsset.toUpperCase();
  if (a === h) return 1;

  const direct = await getAssetToAssetRate(symbols, a, h);
  if (direct) return direct;

  // 2-hop pricing for edge assets.
  const mids = ['USDC', 'USDT', 'BTC', 'ETH', 'BNB'];
  for (const mid of mids) {
    const m = mid.toUpperCase();
    if (m === a || m === h) continue;
    const leg1 = await getAssetToAssetRate(symbols, a, m);
    if (!leg1) continue;
    const leg2 = await getAssetToAssetRate(symbols, m, h);
    if (!leg2) continue;
    return leg1 * leg2;
  }

  return null;
};

const computeEquityHomeSpot = async (
  balances: Balance[],
  homeAsset: string,
): Promise<{ equityHome: number; missingAssets: string[] }> => {
  const symbols = await fetchTradableSymbols();
  const totals = balanceTotals(balances);
  const home = homeAsset.toUpperCase();

  let equityHome = 0;
  const missingAssets: string[] = [];

  for (const [asset, row] of totals.entries()) {
    const amount = row.total;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (asset === home) {
      equityHome += amount;
      continue;
    }
    try {
      const rate = await getAssetToHomeRate(symbols, asset, home);
      if (!rate || !Number.isFinite(rate) || rate <= 0) {
        missingAssets.push(asset);
        continue;
      }
      equityHome += amount * rate;
    } catch {
      missingAssets.push(asset);
    }
  }

  return { equityHome, missingAssets };
};

const computeEquityHome = async (): Promise<{ equityHome: number; homeAsset: string; missingAssets: string[] }> => {
  const home = config.homeAsset.toUpperCase();
  if (config.tradeVenue === 'futures') {
    const futuresEq = await getFuturesEquity();
    const equityHome = futuresEq?.equity ?? 0;
    const asset = futuresEq?.asset?.toUpperCase?.() ? futuresEq.asset.toUpperCase() : home;
    return { equityHome, homeAsset: asset, missingAssets: [] };
  }

  const balances = await getBalances();
  const computed = await computeEquityHomeSpot(balances, home);
  return { equityHome: computed.equityHome, homeAsset: home, missingAssets: computed.missingAssets };
};

const computeFeeBurnPct = (feePoints: FeePoint[]) => {
  const feesHome = feePoints.reduce((sum, p) => sum + clampNonNegative(p.feesHome), 0);
  const notionalHome = feePoints.reduce((sum, p) => sum + clampNonNegative(p.notionalHome), 0);
  if (notionalHome <= 0) return null;
  return (feesHome / notionalHome) * 100;
};

const computeTrendSignals = async (symbol: string) => {
  // Use medium horizon (1h) as a general "regime" proxy.
  const interval = '1h';
  try {
    const ind = await fetchIndicatorSnapshot(symbol, interval, 200);
    const price = ind.close;
    const atr = ind.atr14;
    const adx = ind.adx14;
    const bb = ind.bb20;
    const ema20 = ind.ema20;
    const ema50 = ind.ema50;

    const atrPct = atr && price > 0 ? (atr / price) * 100 : null;

    const emaAligned = ema20 !== null && ema50 !== null ? ema20 !== ema50 : null;
    const bearish = ema20 !== null && ema50 !== null ? ema20 < ema50 : null;

    const bollingerBreak =
      bb.lower !== null && bb.upper !== null && price > 0
        ? price > bb.upper || price < bb.lower
        : null;

    return {
      ok: true as const,
      adx,
      atrPct,
      bbLower: bb.lower,
      bbUpper: bb.upper,
      emaAligned,
      bearish,
      bollingerBreak,
      asOf: ind.asOf,
    };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), symbol }, 'Risk governor: indicator fetch failed');
    return { ok: false as const };
  }
};

export const evaluateRiskGovernor = (params: {
  now: number;
  prev: RiskGovernorDecision | null;
  equityNow: number;
  dailyBaseline: number | null;
  rollingBaseline: number | null;
  feeBurnPct: number | null;
  trend: { adx: number | null; atrPct: number | null; bollingerBreak: boolean | null; emaAligned: boolean | null } | null;
}): RiskGovernorDecision => {
  const now = params.now;
  const prev = params.prev;

  const minStateSeconds = Math.max(0, config.riskMinStateSeconds);
  const haltMinSeconds = Math.max(0, config.riskHaltMinSeconds);

  const ddDaily = params.dailyBaseline !== null ? percentDrawdown(params.dailyBaseline, params.equityNow) : 0;
  const ddRolling = params.rollingBaseline !== null ? percentDrawdown(params.rollingBaseline, params.equityNow) : 0;

  const ddCaution = Math.max(0, config.riskDrawdownCautionPct);
  const ddHalt = Math.max(0, config.riskDrawdownHaltPct);

  const feeCaution = Math.max(0, config.riskFeeBurnCautionPct);
  const feeHalt = Math.max(0, config.riskFeeBurnHaltPct);

  const adxOn = Math.max(0, config.riskTrendAdxOn);
  const adxOff = Math.max(0, config.riskTrendAdxOff);

  const adx = params.trend?.adx ?? null;
  const atrPct = params.trend?.atrPct ?? null;
  const bollingerBreak = params.trend?.bollingerBreak ?? null;
  const emaAligned = params.trend?.emaAligned ?? null;

  const reasons: RiskGovernorDecision['reasons'] = [];

  const isTrendingOn = adx !== null && Number.isFinite(adx) && adx >= adxOn && (emaAligned ?? true);
  const isTrendingOff = adx !== null && Number.isFinite(adx) && adx <= adxOff;

  if (ddDaily >= ddCaution && ddCaution > 0) {
    reasons.push({
      code: 'drawdown_daily',
      detail: `Daily drawdown ${ddDaily.toFixed(2)}% >= ${ddCaution.toFixed(2)}%`,
    });
  }
  if (ddRolling >= ddCaution && ddCaution > 0) {
    reasons.push({
      code: 'drawdown_rolling',
      detail: `Rolling drawdown ${ddRolling.toFixed(2)}% >= ${ddCaution.toFixed(2)}%`,
    });
  }

  if (isTrendingOn) {
    reasons.push({
      code: 'trend',
      detail: `Trend regime: ADX ${adx?.toFixed(1)} >= ${adxOn.toFixed(1)}`,
    });
  }

  if (params.feeBurnPct !== null && Number.isFinite(params.feeBurnPct) && params.feeBurnPct >= feeCaution && feeCaution > 0) {
    reasons.push({
      code: 'fee_burn',
      detail: `Fee burn ${params.feeBurnPct.toFixed(2)}% >= ${feeCaution.toFixed(2)}%`,
    });
  }

  // Extra context-only reason for explainability; doesn't trigger state alone.
  if (atrPct !== null && Number.isFinite(atrPct) && atrPct > 0 && atrPct >= Math.max(8, config.gridAtrPctMax)) {
    reasons.push({
      code: 'vol_spike',
      detail: `ATR% elevated: ${atrPct.toFixed(2)}%`,
    });
  }
  if (bollingerBreak === true) {
    reasons.push({
      code: 'manual',
      detail: 'Bollinger breakout detected',
    });
  }

  const wantsHalt =
    (ddDaily >= ddHalt && ddHalt > 0) ||
    (ddRolling >= ddHalt && ddHalt > 0) ||
    (params.feeBurnPct !== null && params.feeBurnPct >= feeHalt && feeHalt > 0);

  const wantsCaution = reasons.some((r) =>
    r.code === 'drawdown_daily' || r.code === 'drawdown_rolling' || r.code === 'trend' || r.code === 'fee_burn',
  );

  const prevState: RiskGovernorState = prev?.state ?? 'NORMAL';
  const prevSince = prev?.since ?? now;
  const heldSeconds = nowSeconds(now) - nowSeconds(prevSince);

  const canLeaveCurrent = heldSeconds >= minStateSeconds;
  const canLeaveHalt = heldSeconds >= haltMinSeconds;

  let nextState: RiskGovernorState = prevState;

  if (prevState === 'HALT') {
    if (wantsHalt) {
      nextState = 'HALT';
    } else if (!canLeaveHalt) {
      nextState = 'HALT';
    } else if (wantsCaution && !(isTrendingOff && ddDaily < ddCaution && ddRolling < ddCaution)) {
      // de-escalate cautiously
      nextState = 'CAUTION';
    } else if (canLeaveCurrent && !wantsCaution) {
      nextState = 'NORMAL';
    } else {
      nextState = wantsCaution ? 'CAUTION' : 'NORMAL';
    }
  } else if (prevState === 'CAUTION') {
    if (wantsHalt) {
      // Enter HALT immediately (but state clock resets).
      nextState = 'HALT';
    } else if (!canLeaveCurrent) {
      nextState = 'CAUTION';
    } else if (!wantsCaution) {
      nextState = 'NORMAL';
    } else if (isTrendingOff && ddDaily < ddCaution && ddRolling < ddCaution && (params.feeBurnPct ?? 0) < feeCaution) {
      nextState = 'NORMAL';
    } else {
      nextState = 'CAUTION';
    }
  } else {
    // NORMAL
    if (wantsHalt) nextState = 'HALT';
    else if (wantsCaution) nextState = 'CAUTION';
    else nextState = 'NORMAL';
  }

  const changed = nextState !== prevState;
  const since = changed ? now : prevSince;

  const entriesPaused = nextState !== 'NORMAL';
  const gridBuyPausedGlobal = nextState === 'HALT' || (nextState === 'CAUTION' && isTrendingOn);

  return {
    state: nextState,
    since,
    reasons,
    entriesPaused,
    gridBuyPausedGlobal,
  };
};

export const riskGovernorTick = async (seedSymbol?: string): Promise<RiskGovernorDecision | null> => {
  if (!config.riskGovernorEnabled) return null;

  const now = Date.now();
  const symbol = (seedSymbol ?? persisted.meta?.activeSymbol ?? config.defaultSymbol).toUpperCase();

  try {
    const eq = await computeEquityHome();
    const equityNow = eq.equityHome;

    // Daily baseline (local day boundary).
    const dayKey = localDayKey(now);
    const prevMeta = persisted.meta?.riskGovernor;
    const prevDaily = prevMeta?.dailyBaseline;
    const dailyBaseline =
      prevDaily && prevDaily.dayKey === dayKey && prevDaily.homeAsset?.toUpperCase() === eq.homeAsset.toUpperCase()
        ? prevDaily.equityHome
        : equityNow;

    // Rolling baseline ring buffer.
    const riskWindowMinutes = Math.max(30, config.riskWindowMinutes);
    const prevRolling = prevMeta?.rollingEquity ?? [];
    const nextRolling = pushRing(prevRolling, { at: now, equityHome: equityNow }, riskWindowMinutes);
    const rollingBaseline =
      nextRolling.length > 0 ? Math.max(...nextRolling.map((p) => (Number.isFinite(p.equityHome) ? p.equityHome : 0))) : null;

    // Fee burn ring buffer (best-effort).
    const feeWindowMinutes = Math.max(30, config.riskWindowMinutes);
    const prevFees = prevMeta?.rollingFees ?? [];
    const nextFees = prevFees.filter((p: { at: number }) => withinMinutes(now, p.at, feeWindowMinutes));
    const feeBurnPct = computeFeeBurnPct(nextFees);

    const trendRaw = await computeTrendSignals(symbol);
    const trend =
      trendRaw.ok
        ? {
            adx: trendRaw.adx ?? null,
            atrPct: trendRaw.atrPct ?? null,
            bollingerBreak: trendRaw.bollingerBreak ?? null,
            emaAligned: trendRaw.emaAligned ?? null,
          }
        : null;

    const prevDecision = prevMeta?.decision ?? null;
    const decision = evaluateRiskGovernor({
      now,
      prev: prevDecision,
      equityNow,
      dailyBaseline,
      rollingBaseline,
      feeBurnPct,
      trend,
    });

    // Persist snapshot (best-effort; state file is local and should be reliable).
    const snap: RiskGovernorSnapshot = {
      decision,
      dailyBaseline: { dayKey, equityHome: dailyBaseline, homeAsset: eq.homeAsset.toUpperCase(), at: now },
      rollingEquity: nextRolling,
      rollingFees: nextFees,
      lastEquityHome: equityNow,
      homeAsset: eq.homeAsset.toUpperCase(),
      missingAssets: eq.missingAssets?.length ? eq.missingAssets : undefined,
      updatedAt: now,
    };

    persistMeta(persisted, { riskGovernor: snap });
    return decision;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Risk governor tick failed');
    return null;
  }
};

export const recordFeeTelemetryBestEffort = (params: {
  at: number;
  feesHome: number | null | undefined;
  notionalHome: number | null | undefined;
  fills: number;
}) => {
  try {
    if (!config.riskGovernorEnabled) return;
    const at = params.at;
    const feesHome = clampNonNegative(params.feesHome ?? 0);
    const notionalHome = clampNonNegative(params.notionalHome ?? 0);
    if (!Number.isFinite(at) || at <= 0) return;
    if (feesHome <= 0 && notionalHome <= 0) return;

    const prev = persisted.meta?.riskGovernor;
    const prevFees = prev?.rollingFees ?? [];
    const riskWindowMinutes = Math.max(30, config.riskWindowMinutes);
    const next = pushRing(prevFees, { at, feesHome, notionalHome, fills: Math.max(0, params.fills ?? 0) }, riskWindowMinutes);

    const merged: RiskGovernorSnapshot = {
      ...(prev ?? {
        decision: null,
        dailyBaseline: null,
        rollingEquity: [],
        rollingFees: [],
        lastEquityHome: 0,
        homeAsset: config.homeAsset.toUpperCase(),
        updatedAt: at,
      }),
      rollingFees: next,
      updatedAt: at,
    };

    persistMeta(persisted, { riskGovernor: merged });
  } catch {
    // ignore
  }
};

// Conservative fee estimate helper (for execution points that don't have per-fill commissions).
export const estimateFeesHome = (notionalHome: number, type: 'maker' | 'taker') => {
  const rate = type === 'maker' ? feeRate.maker : feeRate.taker;
  const n = clampNonNegative(notionalHome);
  return n > 0 ? n * rate : 0;
};

export const __test__ = {
  localDayKey,
  percentDrawdown,
  evaluateRiskGovernor,
  computeFeeBurnPct,
} as const;