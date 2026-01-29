type WindowParse = { windowMs: number; note?: string };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const parseWindowMs = (window: string | undefined, fallbackMs = 24 * 60 * 60_000): WindowParse => {
  const raw = (window ?? '').trim().toLowerCase();
  if (!raw) return { windowMs: fallbackMs };

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return { windowMs: fallbackMs, note: `Invalid window="${window}". Using default.` };
    const windowMs = clamp(Math.floor(seconds * 1000), 60_000, 365 * 24 * 60 * 60_000);
    return { windowMs, note: `Interpreted window="${window}" as seconds.` };
  }

  const re = /(\d+(?:\.\d+)?)([smhdw])/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(raw))) {
    matched = true;
    const value = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(value) || value <= 0) continue;
    const factor =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 60 * 60_000
            : unit === 'd'
              ? 24 * 60 * 60_000
              : unit === 'w'
                ? 7 * 24 * 60 * 60_000
                : 0;
    total += value * factor;
  }

  if (!matched || !Number.isFinite(total) || total <= 0) {
    return { windowMs: fallbackMs, note: `Invalid window="${window}". Using default.` };
  }

  const windowMs = clamp(Math.floor(total), 60_000, 365 * 24 * 60 * 60_000);
  return { windowMs };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

type GridFillRow = {
  at: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  executedQty: number;
  notional: number;
  feeEst?: number | null;
  price?: number | null;
  orderId?: string | null;
};

type Lot = { qty: number; price: number };

const uniqNotes = (notes: string[]) => Array.from(new Set(notes));

const dedupeGridFills = (rows: GridFillRow[]) => {
  const byOrder = new Map<string, GridFillRow>();
  const passthrough: GridFillRow[] = [];

  for (const row of rows) {
    const orderId = row.orderId ? String(row.orderId) : null;
    if (!orderId) {
      passthrough.push(row);
      continue;
    }
    const key = `${row.symbol}:${row.side}:${orderId}`;
    const prev = byOrder.get(key);
    if (!prev) {
      byOrder.set(key, row);
      continue;
    }
    if (row.executedQty > prev.executedQty || row.notional > prev.notional || row.at > prev.at) {
      byOrder.set(key, row);
    }
  }

  return [...byOrder.values(), ...passthrough].sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
};

const snapshotGridTotals = (
  state: Map<string, { lots: Lot[]; realized: number; fees: number }>,
  prices: Map<string, number>,
  notes: string[],
): { realized: number; unrealized: number; fees: number } => {
  let realized = 0;
  let fees = 0;
  let unrealized = 0;

  for (const [symbol, s] of state) {
    realized += s.realized;
    fees += s.fees;
    const price = prices.get(symbol);
    if (!price || !Number.isFinite(price) || price <= 0) {
      if (s.lots.some((l) => l.qty > 0)) notes.push(`Missing price for ${symbol} (grid unrealized skipped).`);
      continue;
    }
    for (const lot of s.lots) {
      if (lot.qty <= 0) continue;
      unrealized += (price - lot.price) * lot.qty;
    }
  }

  return { realized, unrealized, fees };
};

export const computeGridPnlDeltas = (args: {
  rows: Array<Record<string, unknown>>;
  startAt: number;
  priceStartBySymbol: Map<string, number>;
  priceNowBySymbol: Map<string, number>;
}): { realizedDelta: number | null; unrealizedDelta: number | null; feesDelta: number | null; notes?: string[] } => {
  const notes: string[] = [];
  const startAt = args.startAt;

  const parsed: GridFillRow[] = [];
  for (const row of args.rows) {
    const at = toNumber(row.at);
    const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    const sideRaw = typeof row.side === 'string' ? row.side.toUpperCase() : '';
    const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? (sideRaw as 'BUY' | 'SELL') : null;
    const executedQty = toNumber(row.executedQty);
    const notional = toNumber(row.notional);
    const feeEst = toNumber(row.feeEst);
    const price = toNumber(row.price);
    const orderId = typeof row.orderId === 'string' ? row.orderId : row.orderId != null ? String(row.orderId) : null;

    if (at === null || !symbol || !side) continue;
    if (executedQty === null || executedQty <= 0) continue;
    if (notional === null || notional <= 0) continue;
    parsed.push({ at, symbol, side, executedQty, notional, feeEst, price, orderId });
  }

  if (!parsed.length) return { realizedDelta: 0, unrealizedDelta: 0, feesDelta: 0 };

  const fills = dedupeGridFills(parsed);

  const state = new Map<string, { lots: Lot[]; realized: number; fees: number }>();
  const notedInventoryShort = new Set<string>();

  let startCaptured = false;
  let startSnap = { realized: 0, unrealized: 0, fees: 0 };

  const ensure = (symbol: string) => {
    const existing = state.get(symbol);
    if (existing) return existing;
    const next = { lots: [] as Lot[], realized: 0, fees: 0 };
    state.set(symbol, next);
    return next;
  };

  for (const fill of fills) {
    if (!startCaptured && fill.at > startAt) {
      startSnap = snapshotGridTotals(state, args.priceStartBySymbol, notes);
      startCaptured = true;
    }

    const s = ensure(fill.symbol);
    const price = fill.price && fill.price > 0 ? fill.price : fill.notional / fill.executedQty;
    const fee = fill.feeEst && fill.feeEst > 0 ? fill.feeEst : 0;
    s.fees += fee;

    if (fill.side === 'BUY') {
      s.lots.push({ qty: fill.executedQty, price });
      continue;
    }

    let remaining = fill.executedQty;
    while (remaining > 0 && s.lots.length) {
      const lot = s.lots[0]!;
      const take = Math.min(remaining, lot.qty);
      s.realized += (price - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 0) s.lots.shift();
    }

    if (remaining > 0 && !notedInventoryShort.has(fill.symbol)) {
      notedInventoryShort.add(fill.symbol);
      notes.push(`Grid sells exceed tracked inventory for ${fill.symbol} (PnL may be understated).`);
    }
  }

  if (!startCaptured) {
    startSnap = snapshotGridTotals(state, args.priceStartBySymbol, notes);
    startCaptured = true;
  }

  const endSnap = snapshotGridTotals(state, args.priceNowBySymbol, notes);

  const realizedDelta = endSnap.realized - startSnap.realized;
  const unrealizedDelta = endSnap.unrealized - startSnap.unrealized;
  const feesDelta = endSnap.fees - startSnap.fees;

  return {
    realizedDelta,
    unrealizedDelta,
    feesDelta,
    notes: notes.length ? uniqNotes(notes) : undefined,
  };
};

type TradeRow = {
  at: number;
  symbol: string;
  positionKey: string;
  event: 'OPEN' | 'CLOSE';
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  quoteAsset: string;
  homeAsset: string;
  feesHome: number | null;
  pnlHome: number | null;
};

const snapshotPortfolioTotals = (
  state: {
    open: Map<string, TradeRow>;
    realized: number;
    fees: number;
  },
  prices: Map<string, number>,
  quoteToHome: Map<string, number>,
  homeAsset: string,
  notes: string[],
): { realized: number; unrealized: number; fees: number } => {
  let unrealized = 0;
  for (const pos of state.open.values()) {
    const sym = pos.symbol.toUpperCase();
    const price = prices.get(sym);
    if (!price || !Number.isFinite(price) || price <= 0) {
      notes.push(`Missing price for ${sym} (portfolio unrealized skipped).`);
      continue;
    }
    const quote = pos.quoteAsset.toUpperCase();
    const home = homeAsset.toUpperCase();
    const rate = quote === home ? 1 : quoteToHome.get(quote);
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      notes.push(`Missing FX rate ${quote}->${home} (portfolio unrealized skipped).`);
      continue;
    }
    const diff = pos.side === 'SELL' ? pos.avgPrice - price : price - pos.avgPrice;
    unrealized += diff * pos.qty * rate;
  }
  return { realized: state.realized, unrealized, fees: state.fees };
};

export const computePortfolioPnlDeltas = (args: {
  rows: Array<Record<string, unknown>>;
  startAt: number;
  priceStartBySymbol: Map<string, number>;
  priceNowBySymbol: Map<string, number>;
  quoteToHomeStart: Map<string, number>;
  quoteToHomeNow: Map<string, number>;
  homeAsset: string;
}): { realizedDelta: number | null; unrealizedDelta: number | null; feesDelta: number | null; notes?: string[] } => {
  const notes: string[] = [];
  const startAt = args.startAt;

  const parsed: TradeRow[] = [];
  for (const row of args.rows) {
    const at = toNumber(row.at);
    const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    const positionKey = typeof row.positionKey === 'string' ? row.positionKey : null;
    const eventRaw = typeof row.event === 'string' ? row.event.toUpperCase() : '';
    const event = eventRaw === 'OPEN' || eventRaw === 'CLOSE' ? (eventRaw as 'OPEN' | 'CLOSE') : null;
    const sideRaw = typeof row.side === 'string' ? row.side.toUpperCase() : '';
    const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? (sideRaw as 'BUY' | 'SELL') : null;
    const qty = toNumber(row.qty);
    const avgPrice = toNumber(row.avgPrice);
    const quoteAsset = typeof row.quoteAsset === 'string' ? row.quoteAsset.toUpperCase() : null;
    const homeAsset = typeof row.homeAsset === 'string' ? row.homeAsset.toUpperCase() : args.homeAsset.toUpperCase();
    const feesHome = toNumber(row.feesHome);
    const pnlHome = toNumber(row.pnlHome);

    if (at === null || !symbol || !event || !side || qty === null || qty <= 0 || avgPrice === null || avgPrice <= 0 || !quoteAsset) {
      continue;
    }
    if (!positionKey) continue;
    parsed.push({ at, symbol, positionKey, event, side, qty, avgPrice, quoteAsset, homeAsset, feesHome, pnlHome });
  }

  if (!parsed.length) return { realizedDelta: 0, unrealizedDelta: 0, feesDelta: 0 };

  parsed.sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));

  const state = {
    open: new Map<string, TradeRow>(),
    realized: 0,
    fees: 0,
  };

  let startCaptured = false;
  let startSnap = { realized: 0, unrealized: 0, fees: 0 };

  const seenMissingClose = new Set<string>();

  for (const ev of parsed) {
    if (!startCaptured && ev.at > startAt) {
      startSnap = snapshotPortfolioTotals(state, args.priceStartBySymbol, args.quoteToHomeStart, args.homeAsset, notes);
      startCaptured = true;
    }

    const fee = ev.feesHome && ev.feesHome > 0 ? ev.feesHome : 0;
    state.fees += fee;

    if (ev.event === 'OPEN') {
      state.open.set(ev.positionKey, ev);
      continue;
    }

    // CLOSE
    if (ev.pnlHome !== null) state.realized += ev.pnlHome;
    const open = state.open.get(ev.positionKey);
    if (!open && !seenMissingClose.has(ev.positionKey)) {
      seenMissingClose.add(ev.positionKey);
      notes.push(`Missing OPEN for position ${ev.positionKey} (portfolio PnL may be incomplete).`);
    }
    state.open.delete(ev.positionKey);
  }

  if (!startCaptured) {
    startSnap = snapshotPortfolioTotals(state, args.priceStartBySymbol, args.quoteToHomeStart, args.homeAsset, notes);
    startCaptured = true;
  }

  const endSnap = snapshotPortfolioTotals(state, args.priceNowBySymbol, args.quoteToHomeNow, args.homeAsset, notes);

  const realizedDelta = endSnap.realized - startSnap.realized;
  const unrealizedDelta = endSnap.unrealized - startSnap.unrealized;
  const feesDelta = endSnap.fees - startSnap.fees;

  return {
    realizedDelta,
    unrealizedDelta,
    feesDelta,
    notes: notes.length ? uniqNotes(notes) : undefined,
  };
};

type TradeFillRow = {
  at: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  notional: number;
  quoteAsset: string | null;
  feesHome: number | null;
  orderId: string | null;
  tradeId: string | null;
};

type FillSnapshot = { realized: number; unrealized: number; fees: number };

type FillState = { quoteAsset: string | null; lots: Lot[]; realizedQuote: number; feesHome: number };

const snapshotFillBySymbol = (
  state: Map<string, FillState>,
  prices: Map<string, number>,
  quoteToHome: Map<string, number>,
  homeAsset: string,
  notes: string[],
): Map<string, FillSnapshot> => {
  const out = new Map<string, FillSnapshot>();
  const home = homeAsset.toUpperCase();

  for (const [symbol, s] of state) {
    const quoteAsset = s.quoteAsset?.toUpperCase() ?? null;
    const rate =
      quoteAsset === null ? null : quoteAsset === home ? 1 : quoteToHome.get(quoteAsset.toUpperCase()) ?? null;

    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      if ((s.realizedQuote !== 0 || s.lots.some((l) => l.qty > 0)) && quoteAsset) {
        notes.push(`Missing FX rate ${quoteAsset}->${home} for ${symbol} (fill PnL skipped).`);
      } else if ((s.realizedQuote !== 0 || s.lots.some((l) => l.qty > 0)) && !quoteAsset) {
        notes.push(`Missing quoteAsset for ${symbol} (fill PnL skipped).`);
      }
      continue;
    }

    const price = prices.get(symbol);
    if (!price || !Number.isFinite(price) || price <= 0) {
      if (s.lots.some((l) => l.qty > 0)) notes.push(`Missing price for ${symbol} (fill unrealized skipped).`);
      out.set(symbol, { realized: s.realizedQuote * rate, unrealized: 0, fees: s.feesHome });
      continue;
    }

    let unrealizedQuote = 0;
    for (const lot of s.lots) {
      if (lot.qty <= 0) continue;
      unrealizedQuote += (price - lot.price) * lot.qty;
    }

    out.set(symbol, { realized: s.realizedQuote * rate, unrealized: unrealizedQuote * rate, fees: s.feesHome });
  }

  return out;
};

const dedupeFillRows = (rows: TradeFillRow[]) => {
  const byTradeId = new Map<string, TradeFillRow>();
  const byOrder = new Map<string, TradeFillRow>();
  const passthrough: TradeFillRow[] = [];

  for (const row of rows) {
    if (row.tradeId) {
      const key = `${row.symbol}:${row.tradeId}`;
      const prev = byTradeId.get(key);
      if (!prev || row.at > prev.at) byTradeId.set(key, row);
      continue;
    }
    if (row.orderId) {
      const key = `${row.symbol}:${row.side}:${row.orderId}`;
      const prev = byOrder.get(key);
      if (!prev) {
        byOrder.set(key, row);
        continue;
      }
      if (row.qty > prev.qty || row.notional > prev.notional || row.at > prev.at) byOrder.set(key, row);
      continue;
    }
    passthrough.push(row);
  }

  return [...byTradeId.values(), ...byOrder.values(), ...passthrough].sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
};

export type FillPnlBySymbolDelta = {
  symbol: string;
  realizedDelta: number;
  unrealizedDelta: number;
  feesDelta: number;
  contribution: number;
};

export const computeFillPnlDeltasBySymbol = (args: {
  rows: Array<Record<string, unknown>>;
  startAt: number;
  priceStartBySymbol: Map<string, number>;
  priceNowBySymbol: Map<string, number>;
  quoteToHomeStart: Map<string, number>;
  quoteToHomeNow: Map<string, number>;
  homeAsset: string;
}): {
  realizedDelta: number | null;
  unrealizedDelta: number | null;
  feesDelta: number | null;
  bySymbol: FillPnlBySymbolDelta[];
  notes?: string[];
} => {
  const notes: string[] = [];
  const startAt = args.startAt;

  const parsed: TradeFillRow[] = [];
  for (const row of args.rows) {
    const at = toNumber(row.at);
    const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    const sideRaw = typeof row.side === 'string' ? row.side.toUpperCase() : '';
    const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? (sideRaw as 'BUY' | 'SELL') : null;
    const qty = toNumber(row.qty);
    const priceRaw = toNumber(row.price ?? row.avgPrice);
    const notionalRaw = toNumber(row.notional);
    const quoteAsset = typeof row.quoteAsset === 'string' ? row.quoteAsset.toUpperCase() : null;
    const feesHome = toNumber(row.feesHome);
    const orderId = typeof row.orderId === 'string' ? row.orderId : row.orderId != null ? String(row.orderId) : null;
    const tradeId = typeof row.tradeId === 'string' ? row.tradeId : row.tradeId != null ? String(row.tradeId) : null;

    if (at === null || !symbol || !side) continue;
    if (qty === null || qty <= 0) continue;

    const price =
      priceRaw !== null && priceRaw > 0
        ? priceRaw
        : notionalRaw !== null && notionalRaw > 0
          ? notionalRaw / qty
          : null;
    if (price === null || price <= 0) continue;

    const notional =
      notionalRaw !== null && notionalRaw > 0 ? notionalRaw : qty > 0 && price > 0 ? qty * price : null;
    if (notional === null || notional <= 0) continue;

    parsed.push({
      at,
      symbol,
      side,
      qty,
      price,
      notional,
      quoteAsset,
      feesHome: feesHome !== null && feesHome >= 0 ? feesHome : null,
      orderId: orderId && orderId !== 'undefined' ? orderId : null,
      tradeId: tradeId && tradeId !== 'undefined' ? tradeId : null,
    });
  }

  if (!parsed.length) return { realizedDelta: 0, unrealizedDelta: 0, feesDelta: 0, bySymbol: [] };

  const fills = dedupeFillRows(parsed);

  const state = new Map<string, FillState>();
  const notedInventoryShort = new Set<string>();

  let startCaptured = false;
  let startSnap = new Map<string, FillSnapshot>();

  const ensure = (symbol: string) => {
    const existing = state.get(symbol);
    if (existing) return existing;
    const next: FillState = { quoteAsset: null, lots: [], realizedQuote: 0, feesHome: 0 };
    state.set(symbol, next);
    return next;
  };

  for (const fill of fills) {
    if (!startCaptured && fill.at > startAt) {
      startSnap = snapshotFillBySymbol(state, args.priceStartBySymbol, args.quoteToHomeStart, args.homeAsset, notes);
      startCaptured = true;
    }

    const s = ensure(fill.symbol);
    if (fill.quoteAsset && !s.quoteAsset) s.quoteAsset = fill.quoteAsset;

    if (fill.feesHome !== null && fill.feesHome > 0) s.feesHome += fill.feesHome;

    if (fill.side === 'BUY') {
      s.lots.push({ qty: fill.qty, price: fill.price });
      continue;
    }

    let remaining = fill.qty;
    while (remaining > 0 && s.lots.length) {
      const lot = s.lots[0]!;
      const take = Math.min(remaining, lot.qty);
      s.realizedQuote += (fill.price - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 0) s.lots.shift();
    }

    if (remaining > 0 && !notedInventoryShort.has(fill.symbol)) {
      notedInventoryShort.add(fill.symbol);
      notes.push(`Sells exceed tracked inventory for ${fill.symbol} (fill PnL may be understated).`);
    }
  }

  if (!startCaptured) {
    startSnap = snapshotFillBySymbol(state, args.priceStartBySymbol, args.quoteToHomeStart, args.homeAsset, notes);
    startCaptured = true;
  }

  const endSnap = snapshotFillBySymbol(state, args.priceNowBySymbol, args.quoteToHomeNow, args.homeAsset, notes);

  const bySymbol: FillPnlBySymbolDelta[] = [];
  let realizedDelta = 0;
  let unrealizedDelta = 0;
  let feesDelta = 0;

  const symbols = new Set<string>([...startSnap.keys(), ...endSnap.keys()]);
  for (const symbol of symbols) {
    const start = startSnap.get(symbol) ?? { realized: 0, unrealized: 0, fees: 0 };
    const end = endSnap.get(symbol) ?? { realized: 0, unrealized: 0, fees: 0 };
    const r = end.realized - start.realized;
    const u = end.unrealized - start.unrealized;
    const f = end.fees - start.fees;
    realizedDelta += r;
    unrealizedDelta += u;
    feesDelta += f;
    bySymbol.push({
      symbol,
      realizedDelta: r,
      unrealizedDelta: u,
      feesDelta: f,
      contribution: r + u - f,
    });
  }

  bySymbol.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.symbol.localeCompare(b.symbol));

  return {
    realizedDelta,
    unrealizedDelta,
    feesDelta,
    bySymbol,
    notes: notes.length ? uniqNotes(notes) : undefined,
  };
};
