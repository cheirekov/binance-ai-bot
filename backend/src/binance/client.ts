import { Spot } from '@binance/connector';
import crypto from 'crypto';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance, MarketSnapshot } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { fetchTradableSymbols } from './exchangeInfo.js';

const client = new Spot(config.binanceApiKey, config.binanceApiSecret, {
  baseURL: config.binanceBaseUrl,
});

type Ticker24hRow = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume?: string;
};

type FuturesAccount = {
  assets: Array<{
    asset: string;
    walletBalance: string;
    availableBalance: string;
    unrealizedProfit?: string;
  }>;
  positions: Array<{
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    unrealizedProfit?: string;
    positionSide?: string;
  }>;
  totalWalletBalance?: string;
  totalMarginBalance?: string;
  totalUnrealizedProfit?: string;
};

let ticker24hCache:
  | {
      fetchedAt: number;
      bySymbol: Map<string, MarketSnapshot>;
    }
  | null = null;

const decimalsForStep = (step?: number): number => {
  if (!step) return 8;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1] ?? 8);
  const [, frac] = s.split('.');
  return frac ? frac.length : 0;
};

const floorToStep = (value: number, step?: number) => {
  if (!step) return value;
  const decimals = decimalsForStep(step);
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(decimals));
};

const toStepString = (value: number, step?: number, fallbackDecimals = 8) => {
  const decimals = step ? decimalsForStep(step) : fallbackDecimals;
  const floored = step ? Math.floor(value / step) * step : value;
  // Important: keep as a fixed decimal string (Binance rejects scientific notation like "5e-7").
  return Number.isFinite(floored) ? floored.toFixed(decimals) : '0';
};

const toFixedStepString = (value: number, step?: number, fallbackDecimals = 8) => {
  const decimals = step ? decimalsForStep(step) : fallbackDecimals;
  return Number.isFinite(value) ? value.toFixed(decimals) : '0';
};

const roundDownToStep = (value: number, step: number): number => {
  const decimals = decimalsForStep(step);
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(decimals));
};

const shiftByTicks = (price: number, tickSize: number, ticks: number): number => {
  const decimals = decimalsForStep(tickSize);
  const factor = 10 ** decimals;
  const tickInt = Math.round(tickSize * factor);
  const priceInt = Math.round(price * factor);
  const next = priceInt + tickInt * ticks;
  return Number((next / factor).toFixed(decimals));
};

export const buildOcoRoundedParams = ({
  side,
  quantity,
  takeProfit,
  stopLoss,
  stepSize,
  tickSize,
}: {
  side: 'BUY' | 'SELL';
  quantity: number;
  takeProfit: number;
  stopLoss: number;
  stepSize?: number;
  tickSize?: number;
}) => {
  if (!tickSize || !Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error('OCO rounding requires a valid tickSize');
  }

  const qty = stepSize ? roundDownToStep(quantity, stepSize) : quantity;
  const price = roundDownToStep(takeProfit, tickSize);
  const stopPrice = roundDownToStep(stopLoss, tickSize);

  // Binance requires stopLimitPrice != stopPrice. Enforce >= 1 tick separation in the correct direction.
  const stopLimitPrice = side === 'SELL' ? shiftByTicks(stopPrice, tickSize, -1) : shiftByTicks(stopPrice, tickSize, 1);

  const qtyStr = toFixedStepString(qty, stepSize);
  const priceStr = toFixedStepString(price, tickSize);
  const stopPriceStr = toFixedStepString(stopPrice, tickSize);
  const stopLimitPriceStr = toFixedStepString(stopLimitPrice, tickSize);

  return {
    qty,
    price,
    stopPrice,
    stopLimitPrice,
    qtyStr,
    priceStr,
    stopPriceStr,
    stopLimitPriceStr,
  };
};

const isFuturesVenue = () => config.tradeVenue === 'futures';

const getSymbolRules = async (symbol: string) => {
  const upper = symbol.toUpperCase();
  const symbols = await fetchTradableSymbols();
  return symbols.find((s) => s.symbol.toUpperCase() === upper);
};

const fetch24hAll = async (): Promise<Map<string, MarketSnapshot>> => {
  const url = isFuturesVenue()
    ? `${config.futuresBaseUrl}/fapi/v1/ticker/24hr`
    : `${config.binanceBaseUrl}/api/v3/ticker/24hr`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance ticker24hr failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Ticker24hRow[];
  const now = Date.now();
  const map = new Map<string, MarketSnapshot>();
  for (const row of data) {
    if (!row?.symbol) continue;
    map.set(row.symbol.toUpperCase(), {
      symbol: row.symbol,
      price: Number(row.lastPrice),
      priceChangePercent: Number(row.priceChangePercent),
      highPrice: Number(row.highPrice),
      lowPrice: Number(row.lowPrice),
      volume: Number(row.volume),
      quoteVolume: row.quoteVolume ? Number(row.quoteVolume) : 0,
      updatedAt: now,
    });
  }
  return map;
};

const fetchFutures24h = async (symbol: string): Promise<MarketSnapshot> => {
  const upper = symbol.toUpperCase();
  const url = `${config.futuresBaseUrl}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(upper)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance futures ticker24hr failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Ticker24hRow;
  return {
    symbol: data.symbol,
    price: Number(data.lastPrice),
    priceChangePercent: Number(data.priceChangePercent),
    highPrice: Number(data.highPrice),
    lowPrice: Number(data.lowPrice),
    volume: Number(data.volume),
    quoteVolume: data.quoteVolume ? Number(data.quoteVolume) : 0,
    updatedAt: Date.now(),
  };
};

export const get24hStats = async (symbol: string): Promise<MarketSnapshot> => {
  const now = Date.now();
  const upper = symbol.toUpperCase();
  const ttlMs = Math.max(10_000, config.refreshSeconds * 1000);
  if (!ticker24hCache || now - ticker24hCache.fetchedAt > ttlMs) {
    try {
      ticker24hCache = {
        fetchedAt: now,
        bySymbol: await fetch24hAll(),
      };
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Falling back to per-symbol ticker24hr calls');
      ticker24hCache = null;
    }
  }
  const cached = ticker24hCache?.bySymbol.get(upper);
  if (cached) return cached;

  if (isFuturesVenue()) {
    return fetchFutures24h(symbol);
  }

  const { data } = await client.ticker24hr(symbol);
  return {
    symbol: data.symbol,
    price: Number(data.lastPrice),
    priceChangePercent: Number(data.priceChangePercent),
    highPrice: Number(data.highPrice),
    lowPrice: Number(data.lowPrice),
    volume: Number(data.volume),
    quoteVolume: data.quoteVolume ? Number(data.quoteVolume) : 0,
    updatedAt: Date.now(),
  };
};

export const getLatestPrice = async (symbol: string): Promise<number> => {
  const upper = symbol.toUpperCase();
  const url = isFuturesVenue()
    ? `${config.futuresBaseUrl}/fapi/v1/ticker/price?symbol=${encodeURIComponent(upper)}`
    : `${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(upper)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance ticker price failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { price?: string };
  const price = data?.price ? Number(data.price) : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Binance ticker price returned invalid value');
  }
  return price;
};

export const getBookTicker = async (symbol: string) => {
  if (isFuturesVenue()) {
    const upper = symbol.toUpperCase();
    const url = `${config.futuresBaseUrl}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(upper)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance futures bookTicker failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { bidPrice: string; askPrice: string };
    return { bid: Number(data.bidPrice), ask: Number(data.askPrice) };
  }
  const { data } = await client.bookTicker(symbol);
  return { bid: Number(data.bidPrice), ask: Number(data.askPrice) };
};

let futuresAccountCache:
  | {
      fetchedAt: number;
      data: FuturesAccount;
    }
  | null = null;

const buildSignedQuery = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
  }
  search.set('timestamp', String(Date.now()));
  search.set('recvWindow', '5000');
  const signature = crypto.createHmac('sha256', config.binanceApiSecret).update(search.toString()).digest('hex');
  search.set('signature', signature);
  return search.toString();
};

const signedFuturesRequest = async <T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> => {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error('Missing BINANCE_API_KEY/BINANCE_API_SECRET');
  }
  const qs = buildSignedQuery(params);
  const url = `${config.futuresBaseUrl}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': config.binanceApiKey,
    },
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    const errObj = (json ?? {}) as { code?: number; msg?: string };
    const msg = errObj?.msg ?? text ?? `HTTP ${res.status}`;
    const code = errObj?.code !== undefined ? ` ${errObj.code}` : '';
    throw new Error(`Binance futures error${code}: ${msg}`);
  }
  return (json as T) ?? ({} as T);
};

const signedSpotRequest = async <T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> => {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error('Missing BINANCE_API_KEY/BINANCE_API_SECRET');
  }
  const qs = buildSignedQuery(params);
  const url = `${config.binanceBaseUrl}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': config.binanceApiKey,
    },
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    const errObj = (json ?? {}) as { code?: number; msg?: string };
    const msg = errObj?.msg ?? text ?? `HTTP ${res.status}`;
    const code = errObj?.code !== undefined ? ` ${errObj.code}` : '';
    throw new Error(`Binance spot error${code}: ${msg}`);
  }
  return (json as T) ?? ({} as T);
};

const getFuturesAccount = async (): Promise<FuturesAccount> => {
  const now = Date.now();
  if (futuresAccountCache && now - futuresAccountCache.fetchedAt < 5_000) return futuresAccountCache.data;
  const data = await signedFuturesRequest<FuturesAccount>('GET', '/fapi/v2/account');
  futuresAccountCache = { fetchedAt: now, data };
  return data;
};

export const getBalances = async (): Promise<Balance[]> => {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    return [];
  }
  if (isFuturesVenue()) {
    try {
      const account = await getFuturesAccount();
      const assets = account.assets ?? [];
      return assets
        .map((a) => {
          const wallet = Number(a.walletBalance);
          const available = Number(a.availableBalance);
          const locked = Number.isFinite(wallet) && Number.isFinite(available) ? Math.max(0, wallet - available) : 0;
          return { asset: a.asset, free: Number.isFinite(available) ? available : 0, locked };
        })
        .filter((b) => (b.free ?? 0) + (b.locked ?? 0) > 0);
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Unable to fetch futures balances');
      return [];
    }
  }
  try {
    const { data } = await client.account();
    return data.balances
      .filter((b: { free: string; locked: string }) => Number(b.free) + Number(b.locked) > 0)
      .map((b: { asset: string; free: string; locked: string }) => ({
        asset: b.asset,
        free: Number(b.free),
        locked: Number(b.locked),
      }));
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Unable to fetch balances (likely using public-only keys)');
    return [];
  }
};

export interface TradeParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  type?: 'MARKET' | 'LIMIT';
  reduceOnly?: boolean; // futures only
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export const getKlines = async (symbol: string, interval: string, limit = 200): Promise<Kline[]> => {
  if (isFuturesVenue()) {
    const upper = symbol.toUpperCase();
    const url = `${config.futuresBaseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(upper)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance futures klines failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as (string | number)[][];
    return data.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }));
  }

  const { data } = await client.klines(symbol, interval, { limit });
  return data.map((row: (string | number)[]) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  }));
};

export const placeOcoOrder = async ({
  symbol,
  side,
  quantity,
  takeProfit,
  stopLoss,
}: {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  takeProfit: number;
  stopLoss: number;
}) => {
  if (isFuturesVenue()) {
    throw new Error('OCO is only supported in spot mode');
  }

  if (side !== 'SELL') {
    throw new Error('OCO supported only for SELL exits (spot long positions)');
  }

  const rules = await getSymbolRules(symbol);
  const { qty, price, stopPrice, stopLimitPrice, qtyStr, priceStr, stopPriceStr, stopLimitPriceStr } =
    buildOcoRoundedParams({
      side,
      quantity,
      takeProfit,
      stopLoss,
      stepSize: rules?.stepSize,
      tickSize: rules?.tickSize,
    });

  if (side === 'SELL' && stopLimitPrice >= stopPrice) {
    throw new Error('Invalid OCO params: stopLimitPrice must be < stopPrice for SELL');
  }

  if (rules?.minQty && qty < rules.minQty) {
    throw new Error(`OCO quantity ${qty} below minQty ${rules.minQty}`);
  }

  if (qty <= 0 || price <= 0 || stopPrice <= 0 || stopLimitPrice <= 0) {
    throw new Error('Invalid OCO params after rounding');
  }

  const { data } = await client.newOCOOrder(symbol, side, qtyStr, 'LIMIT_MAKER', 'STOP_LOSS_LIMIT', {
    abovePrice: priceStr,
    belowStopPrice: stopPriceStr,
    belowPrice: stopLimitPriceStr,
    belowTimeInForce: 'GTC',
  });
  return data;
};

export const cancelOcoOrder = async (symbol: string, orderListId: number) => {
  if (isFuturesVenue()) {
    throw new Error('OCO cancel is only supported in spot mode');
  }
  const { data } = await client.cancelOCOOrder(symbol, { orderListId });
  return data;
};

export const getOpenOrders = async (symbol?: string): Promise<unknown[]> => {
  if (isFuturesVenue()) {
    const data = await signedFuturesRequest<unknown[]>(
      'GET',
      '/fapi/v1/openOrders',
      symbol ? { symbol: symbol.toUpperCase() } : {},
    );
    return Array.isArray(data) ? data : [];
  }
  const { data } = await client.openOrders(symbol ? { symbol } : {});
  return Array.isArray(data) ? (data as unknown[]) : [];
};

export const getOrder = async (symbol: string, orderId: number): Promise<unknown> => {
  if (isFuturesVenue()) {
    return signedFuturesRequest('GET', '/fapi/v1/order', { symbol: symbol.toUpperCase(), orderId });
  }
  const { data } = await client.getOrder(symbol, { orderId });
  return data;
};

export const getOrderHistory = async (symbol: string, limit = 50): Promise<unknown[]> => {
  const upper = symbol.toUpperCase();
  const capped = Math.max(1, Math.min(200, limit));
  if (isFuturesVenue()) {
    const data = await signedFuturesRequest<unknown[]>('GET', '/fapi/v1/allOrders', { symbol: upper, limit: capped });
    return Array.isArray(data) ? data : [];
  }
  const data = await signedSpotRequest<unknown[]>('GET', '/api/v3/allOrders', { symbol: upper, limit: capped });
  return Array.isArray(data) ? data : [];
};

export const cancelOrder = async (symbol: string, orderId: number): Promise<unknown> => {
  if (isFuturesVenue()) {
    return signedFuturesRequest('DELETE', '/fapi/v1/order', { symbol: symbol.toUpperCase(), orderId });
  }
  const { data } = await client.cancelOrder(symbol, { orderId });
  return data;
};

export const getOpenOcoOrders = async (): Promise<unknown[]> => {
  if (isFuturesVenue()) {
    throw new Error('OCO is only supported in spot mode');
  }
  const { data } = await client.getOpenOCOOrders();
  return Array.isArray(data) ? (data as unknown[]) : [];
};

export const getOcoOrder = async (orderListId: number): Promise<unknown> => {
  if (isFuturesVenue()) {
    throw new Error('OCO is only supported in spot mode');
  }
  const { data } = await client.getOCOOrder({ orderListId });
  return data;
};

export const placeOrder = async (params: TradeParams) => {
  if (!config.tradingEnabled) {
    throw new Error('Trading is disabled; set TRADING_ENABLED=true to place live orders.');
  }
  if (isFuturesVenue() && !config.futuresEnabled) {
    throw new Error('Futures trading is disabled; set FUTURES_ENABLED=true to place futures orders.');
  }

  const rules = await getSymbolRules(params.symbol);
  const adjustedQty = floorToStep(params.quantity, rules?.stepSize);
  const adjustedQtyStr = toStepString(adjustedQty, rules?.stepSize);
  if (rules?.minQty && adjustedQty < rules.minQty) {
    throw new Error(`Quantity ${adjustedQty} below minQty ${rules.minQty}`);
  }

  const notionalPrice = params.price ?? (await get24hStats(params.symbol)).price;
  if (rules?.minNotional && adjustedQty * notionalPrice < rules.minNotional) {
    throw new Error(
      `Notional ${(adjustedQty * notionalPrice).toFixed(8)} below minNotional ${rules.minNotional}`,
    );
  }

  const orderType = params.type ?? 'MARKET';
  const adjustedPrice =
    orderType === 'LIMIT' && params.price !== undefined
      ? floorToStep(params.price, rules?.tickSize)
      : undefined;
  const adjustedPriceStr =
    orderType === 'LIMIT' && adjustedPrice !== undefined ? toStepString(adjustedPrice, rules?.tickSize) : undefined;
  if (orderType === 'LIMIT' && adjustedPrice === undefined) {
    throw new Error('LIMIT order requires price');
  }

  if (isFuturesVenue()) {
    // Ensure leverage/margin settings before first trade on a symbol.
    const upper = params.symbol.toUpperCase();
    try {
      await signedFuturesRequest('POST', '/fapi/v1/leverage', { symbol: upper, leverage: config.futuresLeverage });
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol: upper }, 'Failed to set futures leverage');
    }
    try {
      await signedFuturesRequest('POST', '/fapi/v1/marginType', { symbol: upper, marginType: config.futuresMarginType });
    } catch (error) {
      // Binance returns an error if margin type is already set; ignore.
    }

    const baseParams: Record<string, string | number | boolean | undefined> = {
      symbol: upper,
      side: params.side,
      type: orderType,
      quantity: adjustedQtyStr,
    };
    if (params.reduceOnly) baseParams.reduceOnly = true;
    if (orderType === 'LIMIT') {
      baseParams.timeInForce = 'GTC';
      baseParams.price = adjustedPriceStr;
    }
    return signedFuturesRequest('POST', '/fapi/v1/order', baseParams);
  }

  const options =
    orderType === 'LIMIT'
      ? { timeInForce: 'GTC', quantity: adjustedQtyStr, price: adjustedPriceStr }
      : { quantity: adjustedQtyStr };

  const { data } = await client.newOrder(params.symbol, params.side, orderType, options);
  return data;
};

export const getFuturesPositions = async (): Promise<
  Array<{ symbol: string; positionAmt: number; entryPrice: number; positionSide?: string }>
> => {
  if (!isFuturesVenue()) return [];
  try {
    const account = await getFuturesAccount();
    return (account.positions ?? [])
      .map((p) => ({
        symbol: p.symbol,
        positionAmt: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        positionSide: p.positionSide,
      }))
      .filter((p) => Number.isFinite(p.positionAmt) && p.positionAmt !== 0);
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Unable to fetch futures positions');
    return [];
  }
};

export const getFuturesEquity = async (): Promise<{ asset: string; equity: number } | null> => {
  if (!isFuturesVenue()) return null;
  try {
    const account = await getFuturesAccount();
    // USD-M futures (fapi) totals are returned in USDT-equivalent terms, even in multi-asset mode.
    // Treat them as USDT and only convert to HOME_ASSET if HOME_ASSET differs.
    const marginAsset = 'USDT';
    const totalMargin = Number(account.totalMarginBalance ?? Number.NaN);
    const rawEquity = Number.isFinite(totalMargin) && totalMargin > 0 ? totalMargin : null;
    const wallet = Number(account.totalWalletBalance ?? Number.NaN);
    const unreal = Number(account.totalUnrealizedProfit ?? 0);
    const derived = wallet + unreal;
    const fallbackEquity = Number.isFinite(derived) && derived > 0 ? derived : null;
    const equity = rawEquity ?? fallbackEquity;
    if (!equity) return null;

    const home = config.homeAsset.toUpperCase();
    if (home === marginAsset) return { asset: home, equity };

    const directSymbol = `${marginAsset}${home}`;
    try {
      const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(directSymbol)}`);
      if (res.ok) {
        const data = (await res.json()) as { price?: string };
        const price = data?.price ? Number(data.price) : Number.NaN;
        if (Number.isFinite(price) && price > 0) return { asset: home, equity: equity * price };
      }
    } catch {
      // ignore
    }

    const inverseSymbol = `${home}${marginAsset}`;
    try {
      const res = await fetch(`${config.binanceBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(inverseSymbol)}`);
      if (res.ok) {
        const data = (await res.json()) as { price?: string };
        const price = data?.price ? Number(data.price) : Number.NaN;
        if (Number.isFinite(price) && price > 0) return { asset: home, equity: equity / price };
      }
    } catch {
      // ignore
    }

    // If conversion is unavailable, return in margin asset.
    return { asset: marginAsset, equity };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Unable to fetch futures equity');
    return null;
  }
};
