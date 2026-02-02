import { cancelOrder, getBalances, getBookTicker, getOrder, placeOrder } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance } from '../types.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';
import { getPersistedState } from './persistence.js';
import { getRate } from './rates.js';

type SymbolInfo = Awaited<ReturnType<typeof fetchTradableSymbols>>[number];

type ConversionStep = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  side: 'BUY' | 'SELL';
  fromAsset: string;
  toAsset: string;
};

export type EnsureAssetBalanceResult = {
  ok: boolean;
  reason?: string;
  steps?: ConversionStep[];
  orders?: Array<{ symbol: string; order: unknown }>;
};

const persisted = getPersistedState();

const upper = (v: string) => v.trim().toUpperCase();

const balanceFreeMap = (balances: Balance[]) => new Map(balances.map((b) => [upper(b.asset), b.free ?? 0]));

const clampNonNegative = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const extractOrderId = (order: unknown): number | null => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  const id = toNumber(rec.orderId);
  return id && Number.isFinite(id) && id > 0 ? id : null;
};

const extractStatus = (order: unknown): string => {
  if (!order || typeof order !== 'object') return '';
  return String((order as Record<string, unknown>).status ?? '').toUpperCase();
};

const extractExecutedQty = (order: unknown): number | null => {
  if (!order || typeof order !== 'object') return null;
  const rec = order as Record<string, unknown>;
  const v = toNumber(rec.executedQty ?? rec.executedQuantity ?? rec.origQty ?? rec.quantity);
  return v && Number.isFinite(v) ? v : null;
};

const isBlockedForConversions = () => {
  if (persisted.meta?.emergencyStop) return { blocked: true, reason: 'Emergency stop enabled' };

  const governorState = persisted.meta?.riskGovernor?.decision?.state ?? null;
  if (governorState === 'HALT') return { blocked: true, reason: 'Risk Governor HALT' };

  // Daily loss cap is enforced by enabling emergencyStop in autoTrader.
  // Still add a defensive check here so conversions cannot happen during a breached cap even if something calls us directly.
  const capPct = Math.abs(config.dailyLossCapPct ?? 0);
  const pnlPct = persisted.meta?.equity?.pnlPct;
  if (capPct > 0 && typeof pnlPct === 'number' && Number.isFinite(pnlPct) && pnlPct <= -capPct) {
    return { blocked: true, reason: `Daily loss cap breached (${pnlPct.toFixed(2)}% <= -${capPct.toFixed(2)}%)` };
  }

  return { blocked: false, reason: '' };
};

const isSpotTradable = (s: SymbolInfo) =>
  s.status === 'TRADING' && ((s.permissions?.includes('SPOT') ?? false) || s.isSpotTradingAllowed);

const findStep = (symbols: SymbolInfo[], fromAsset: string, toAsset: string): ConversionStep | null => {
  const from = upper(fromAsset);
  const to = upper(toAsset);
  if (!from || !to || from === to) return null;

  // BUY base=to using quote=from
  const direct = symbols.find(
    (s) => isSpotTradable(s) && upper(s.baseAsset) === to && upper(s.quoteAsset) === from,
  );
  if (direct) {
    return {
      symbol: upper(direct.symbol),
      baseAsset: upper(direct.baseAsset),
      quoteAsset: upper(direct.quoteAsset),
      side: 'BUY',
      fromAsset: from,
      toAsset: to,
    };
  }

  // SELL base=from to receive quote=to
  const inverse = symbols.find(
    (s) => isSpotTradable(s) && upper(s.baseAsset) === from && upper(s.quoteAsset) === to,
  );
  if (inverse) {
    return {
      symbol: upper(inverse.symbol),
      baseAsset: upper(inverse.baseAsset),
      quoteAsset: upper(inverse.quoteAsset),
      side: 'SELL',
      fromAsset: from,
      toAsset: to,
    };
  }

  return null;
};

const computeTwoHopPath = (symbols: SymbolInfo[], fromAsset: string, toAsset: string): ConversionStep[] | null => {
  const from = upper(fromAsset);
  const to = upper(toAsset);
  const bridges = (config.bridgeAssets ?? []).map(upper).filter(Boolean);

  for (const mid of bridges) {
    if (mid === from || mid === to) continue;
    if ((config.excludedAssets ?? []).map(upper).includes(mid)) continue;

    const leg1 = findStep(symbols, from, mid);
    if (!leg1) continue;
    const leg2 = findStep(symbols, mid, to);
    if (!leg2) continue;

    return [leg1, leg2];
  }

  return null;
};

const computePath = async (fromAsset: string, toAsset: string): Promise<ConversionStep[] | null> => {
  const from = upper(fromAsset);
  const to = upper(toAsset);
  if (from === to) return [];

  const symbols = await fetchTradableSymbols();
  const direct = findStep(symbols, from, to);
  if (direct) return [direct];

  return computeTwoHopPath(symbols, from, to);
};

const getDesiredMidAmountForSecondLeg = async (leg2: ConversionStep, desiredTarget: number) => {
  const want = clampNonNegative(desiredTarget);
  if (want <= 0) return 0;

  const book = await getBookTicker(leg2.symbol);
  const bid = clampNonNegative(book.bid);
  const ask = clampNonNegative(book.ask);
  const slippage = Math.max(0, config.convertSlippageBps) / 10_000;

  // leg2.fromAsset === mid, leg2.toAsset === target
  if (leg2.side === 'BUY') {
    // BUY target (base) using mid (quote): need mid ~= targetQty * ask
    return want * ask * (1 + slippage);
  }

  // SELL mid (base) into target (quote): need mid ~= targetQty / bid
  if (bid <= 0) return 0;
  return (want / bid) * (1 + slippage);
};

const placeLimitTtl = async (step: ConversionStep, desiredToAmount: number) => {
  const slippage = Math.max(0, config.convertSlippageBps) / 10_000;
  const ttlMs = Math.max(1, Math.floor(config.convertTtlSeconds)) * 1000;

  const startedAt = Date.now();
  const book = await getBookTicker(step.symbol);
  const bid = clampNonNegative(book.bid);
  const ask = clampNonNegative(book.ask);

  if (bid <= 0 || ask <= 0) throw new Error('Book ticker invalid');

  const price =
    step.side === 'BUY' ? ask * (1 + slippage) : bid * (1 - slippage);

  const qtyBase =
    step.side === 'BUY'
      ? clampNonNegative(desiredToAmount)
      : (() => {
          // SELL base=from to receive quote=to; desiredToAmount is quote needed
          if (price <= 0) return 0;
          return clampNonNegative(desiredToAmount / price) * (1 + slippage);
        })();

  if (!Number.isFinite(qtyBase) || qtyBase <= 0) throw new Error('Conversion sizing failed');

  const order = await placeOrder({
    symbol: step.symbol,
    side: step.side,
    quantity: qtyBase,
    price,
    type: 'LIMIT',
  });

  const orderId = extractOrderId(order);
  if (!orderId) return { order, filled: true, note: 'Placed limit order (no orderId in response)' };

  // Poll until filled or TTL, then cancel.
  while (Date.now() - startedAt < ttlMs) {
    try {
      const detail = await getOrder(step.symbol, orderId);
      const status = extractStatus(detail);
      if (status === 'FILLED') return { order: detail, filled: true, note: 'Filled' };
      if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
        return { order: detail, filled: false, note: `Order ${status}` };
      }
      // allow short sleep between polls (no setTimeout; this runs inside tick loop)
      await new Promise((r) => setTimeout(r, 350));
    } catch {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  try {
    await cancelOrder(step.symbol, orderId);
  } catch {
    // ignore
  }

  // Best-effort: fetch final status
  try {
    const final = await getOrder(step.symbol, orderId);
    const status = extractStatus(final);
    return { order: final, filled: status === 'FILLED', note: `TTL done: ${status || 'UNKNOWN'}` };
  } catch {
    return { order, filled: false, note: 'TTL done: cancel attempted' };
  }
};

const placeMarket = async (step: ConversionStep, desiredToAmount: number) => {
  const slippage = Math.max(0, config.convertSlippageBps) / 10_000;
  const book = await getBookTicker(step.symbol);
  const bid = clampNonNegative(book.bid);
  const ask = clampNonNegative(book.ask);
  const price = step.side === 'BUY' ? ask : bid;

  const qtyBase =
    step.side === 'BUY'
      ? clampNonNegative(desiredToAmount) * (1 + slippage)
      : (() => {
          if (price <= 0) return 0;
          return clampNonNegative(desiredToAmount / price) * (1 + slippage);
        })();

  if (!Number.isFinite(qtyBase) || qtyBase <= 0) throw new Error('Conversion sizing failed');

  const order = await placeOrder({
    symbol: step.symbol,
    side: step.side,
    quantity: qtyBase,
    type: 'MARKET',
  });

  return { order, filled: true, note: 'Placed market order' };
};

type QuotePoolTarget = { asset: string; targetPct: number };

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

const getEquityHomeBestEffort = (homeAsset: string) => {
  const home = upper(homeAsset);
  const rg = persisted.meta?.riskGovernor;
  const eqFromGovernor = rg?.homeAsset?.toUpperCase() === home ? rg.lastEquityHome : null;
  if (typeof eqFromGovernor === 'number' && Number.isFinite(eqFromGovernor) && eqFromGovernor > 0) return eqFromGovernor;

  const eq = persisted.meta?.equity;
  const eqFromTelemetry = eq?.homeAsset?.toUpperCase() === home ? eq.lastHome : null;
  if (typeof eqFromTelemetry === 'number' && Number.isFinite(eqFromTelemetry) && eqFromTelemetry > 0) return eqFromTelemetry;

  return null;
};

const getQuotePoolTopUpTarget = async (params: { targetAsset: string; homeAsset: string; haveTarget: number }) => {
  const home = upper(params.homeAsset);
  const target = upper(params.targetAsset);
  if (!home || !target) return null;

  const targets = parseQuotePoolTargets(config.quotePoolTargetsRaw);
  const match = targets.find((t) => upper(t.asset) === target);
  if (!match) return null;

  const equityHome = getEquityHomeBestEffort(home);
  if (!equityHome) return null;

  const thresholdBps = Math.max(0, config.quotePoolRebalanceBps);
  const thresholdPct = thresholdBps / 10_000;

  const rate = target === home ? 1 : await getRate(target, home);
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;

  const haveHomeValue = clampNonNegative(params.haveTarget) * rate;
  const havePct = equityHome > 0 ? haveHomeValue / equityHome : 0;

  const targetPct = Math.max(0, Math.min(0.95, match.targetPct));
  if (havePct >= targetPct - thresholdPct) return null;

  const desiredHomeValue = targetPct * equityHome;
  const desiredTarget = desiredHomeValue / rate;

  return Number.isFinite(desiredTarget) && desiredTarget > 0 ? desiredTarget : null;
};

export const ensureAssetBalance = async (
  targetAssetInput: string,
  targetAmountInput: number,
  sourceAssetInput?: string,
): Promise<EnsureAssetBalanceResult> => {
  const targetAsset = upper(targetAssetInput);
  const sourceAsset = upper(sourceAssetInput ?? config.homeAsset);

  if (!targetAsset) return { ok: false, reason: 'Missing target asset' };
  if (targetAsset === sourceAsset) return { ok: true, reason: 'Already in source asset' };

  let targetAmount = clampNonNegative(targetAmountInput);
  if (targetAmount <= 0) return { ok: true, reason: 'No target amount requested' };

  if (config.tradeVenue !== 'spot') return { ok: false, reason: 'Conversions supported only in spot mode' };
  if (!config.conversionEnabled) return { ok: false, reason: 'CONVERSION_ENABLED=false' };
  if (!config.tradingEnabled) return { ok: false, reason: 'TRADING_ENABLED=false' };

  const block = isBlockedForConversions();
  if (block.blocked) return { ok: false, reason: block.reason };

  const balances = await getBalances();
  const freeBy = balanceFreeMap(balances);
  const have = clampNonNegative(freeBy.get(targetAsset) ?? 0);

  // Quote pool integration: if this asset is a configured pool target, and we're converting from HOME,
  // optionally top up to the pool target (only when below threshold) to reduce repeated small conversions.
  if (sourceAsset === upper(config.homeAsset)) {
    try {
      const poolTopUpTarget = await getQuotePoolTopUpTarget({
        targetAsset,
        homeAsset: config.homeAsset,
        haveTarget: have,
      });
      if (poolTopUpTarget !== null && poolTopUpTarget > targetAmount) {
        targetAmount = poolTopUpTarget;
      }
    } catch {
      // ignore (best-effort)
    }
  }

  const missing = clampNonNegative(targetAmount - have);
  if (missing <= 0) return { ok: true, reason: 'Sufficient balance' };

  const path = await computePath(sourceAsset, targetAsset);
  if (!path || path.length === 0) return { ok: false, reason: `No conversion path ${sourceAsset}->${targetAsset}` };

  const orders: Array<{ symbol: string; order: unknown }> = [];

  try {
    if (path.length === 1) {
      const step = path[0]!;
      const retries = Math.max(0, Math.floor(config.convertMaxRetries));
      let remainingTo = missing;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const blocked = isBlockedForConversions();
        if (blocked.blocked) return { ok: false, reason: blocked.reason, steps: path, orders };

        const exec =
          config.convertMode === 'market'
            ? await placeMarket(step, remainingTo)
            : await placeLimitTtl(step, remainingTo);

        orders.push({ symbol: step.symbol, order: exec.order });

        const executed = extractExecutedQty(exec.order) ?? 0;
        if (step.side === 'BUY') remainingTo = Math.max(0, remainingTo - executed);
        else {
          // For SELL, we can't reliably infer quote received here; stop after one attempt.
          remainingTo = 0;
        }

        if (remainingTo <= 0) break;
      }

      return { ok: true, steps: path, orders };
    }

    // 2-hop: source -> mid -> target
    const [leg1, leg2] = path;

    const needMid = await getDesiredMidAmountForSecondLeg(leg2!, missing);
    if (needMid <= 0) return { ok: false, reason: 'Conversion sizing failed (mid)', steps: path };

    // Ensure MID balance first (best-effort).
    const midAsset = upper(leg2!.fromAsset);
    const balances1 = await getBalances();
    const freeMid = clampNonNegative(balanceFreeMap(balances1).get(midAsset) ?? 0);
    const midMissing = Math.max(0, needMid - freeMid);

    if (midMissing > 0) {
      const exec1 =
        config.convertMode === 'market'
          ? await placeMarket(leg1!, midMissing)
          : await placeLimitTtl(leg1!, midMissing);
      orders.push({ symbol: leg1!.symbol, order: exec1.order });
    }

    const blocked2 = isBlockedForConversions();
    if (blocked2.blocked) return { ok: false, reason: blocked2.reason, steps: path, orders };

    const exec2 =
      config.convertMode === 'market'
        ? await placeMarket(leg2!, missing)
        : await placeLimitTtl(leg2!, missing);
    orders.push({ symbol: leg2!.symbol, order: exec2.order });

    return { ok: true, steps: path, orders };
  } catch (error) {
    logger.warn(
      { err: errorToLogObject(error), from: sourceAsset, to: targetAsset },
      'Conversion router failed',
    );
    return { ok: false, reason: errorToString(error), steps: path, orders };
  }
};