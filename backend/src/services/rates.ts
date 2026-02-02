import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';

type SpotExchangeInfo = {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    isSpotTradingAllowed?: boolean;
    permissions?: string[];
  }>;
};

type TickerPriceRow = { symbol: string; price: string };

type RateGraph = {
  builtAt: number;
  // fromAsset -> (toAsset -> rate)
  edges: Map<string, Map<string, number>>;
};

const GRAPH_TTL_MS = 10_000;

let cache: RateGraph | null = null;

const upper = (v: string) => v.trim().toUpperCase();

const isSpotTradable = (s: SpotExchangeInfo['symbols'][number]) => {
  if (s.status !== 'TRADING') return false;
  if (s.permissions?.includes('SPOT')) return true;
  return s.isSpotTradingAllowed === true;
};

const addEdge = (edges: RateGraph['edges'], from: string, to: string, rate: number) => {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const fromMap = edges.get(from) ?? new Map<string, number>();
  fromMap.set(to, rate);
  edges.set(from, fromMap);
};

const fetchSpotExchangeInfo = async (): Promise<SpotExchangeInfo> => {
  const url = `${config.binanceBaseUrl}/api/v3/exchangeInfo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance exchangeInfo failed: HTTP ${res.status}`);
  return (await res.json()) as SpotExchangeInfo;
};

const fetchSpotTickerPrices = async (): Promise<TickerPriceRow[]> => {
  const url = `${config.binanceBaseUrl}/api/v3/ticker/price`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker/price failed: HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as TickerPriceRow[]) : [];
};

const buildGraph = async (): Promise<RateGraph> => {
  const [exchangeInfo, tickers] = await Promise.all([fetchSpotExchangeInfo(), fetchSpotTickerPrices()]);

  const priceBySymbol = new Map<string, number>();
  for (const row of tickers) {
    if (!row?.symbol) continue;
    const p = Number(row.price);
    if (!Number.isFinite(p) || p <= 0) continue;
    priceBySymbol.set(upper(row.symbol), p);
  }

  const edges: RateGraph['edges'] = new Map();

  for (const s of exchangeInfo.symbols) {
    if (!s?.symbol || !s.baseAsset || !s.quoteAsset) continue;
    if (!isSpotTradable(s)) continue;

    const sym = upper(s.symbol);
    const base = upper(s.baseAsset);
    const quote = upper(s.quoteAsset);
    const p = priceBySymbol.get(sym);
    if (!p) continue;

    // base -> quote
    addEdge(edges, base, quote, p);
    // quote -> base
    addEdge(edges, quote, base, 1 / p);
  }

  return { builtAt: Date.now(), edges };
};

const getGraph = async (): Promise<RateGraph> => {
  const now = Date.now();
  if (cache && now - cache.builtAt < GRAPH_TTL_MS) return cache;

  try {
    cache = await buildGraph();
    return cache;
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Rates graph build failed');
    // Fail open (no rates) but keep previous cache if available.
    if (cache) return cache;
    return { builtAt: now, edges: new Map() };
  }
};

const getDirectRate = (graph: RateGraph, fromAsset: string, toAsset: string): number | null => {
  const from = upper(fromAsset);
  const to = upper(toAsset);
  if (!from || !to) return null;
  if (from === to) return 1;

  const toMap = graph.edges.get(from);
  const direct = toMap?.get(to);
  return direct && Number.isFinite(direct) && direct > 0 ? direct : null;
};

export const getRate = async (fromAsset: string, toAsset: string): Promise<number | null> => {
  const from = upper(fromAsset);
  const to = upper(toAsset);
  if (!from || !to) return null;
  if (from === to) return 1;

  const excluded = new Set((config.excludedAssets ?? []).map(upper));
  if (excluded.has(from) || excluded.has(to)) return null;

  const graph = await getGraph();

  const direct = getDirectRate(graph, from, to);
  if (direct) return direct;

  const bridges = (config.bridgeAssets ?? []).map(upper).filter(Boolean);

  for (const mid of bridges) {
    if (mid === from || mid === to) continue;
    if (excluded.has(mid)) continue;
    const leg1 = getDirectRate(graph, from, mid);
    if (!leg1) continue;
    const leg2 = getDirectRate(graph, mid, to);
    if (!leg2) continue;
    const rate = leg1 * leg2;
    if (Number.isFinite(rate) && rate > 0) return rate;
  }

  return null;
};

export const getRateDebug = async (fromAsset: string, toAsset: string) => {
  const graph = await getGraph();
  return {
    builtAt: graph.builtAt,
    from: upper(fromAsset),
    to: upper(toAsset),
    direct: getDirectRate(graph, fromAsset, toAsset),
    bridges: (config.bridgeAssets ?? []).map(upper),
  };
};

export const resetRatesCache = () => {
  cache = null;
};