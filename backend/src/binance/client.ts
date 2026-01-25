import { Spot } from '@binance/connector';

import { fetchTradableSymbols } from './exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance, MarketSnapshot } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';

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

const getSymbolRules = async (symbol: string) => {
  const upper = symbol.toUpperCase();
  const symbols = await fetchTradableSymbols();
  return symbols.find((s) => s.symbol.toUpperCase() === upper);
};

const fetch24hAll = async (): Promise<Map<string, MarketSnapshot>> => {
  const url = `${config.binanceBaseUrl}/api/v3/ticker/24hr`;
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

export const getBookTicker = async (symbol: string) => {
  const { data } = await client.bookTicker(symbol);
  return {
    bid: Number(data.bidPrice),
    ask: Number(data.askPrice),
  };
};

export const getBalances = async (): Promise<Balance[]> => {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    return [];
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
  const { data } = await client.klines(symbol, interval, { limit });
  return data.map((row: (string | number)[]) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
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
  if (side !== 'SELL') {
    throw new Error('OCO supported only for SELL exits (spot long positions)');
  }

  const rules = await getSymbolRules(symbol);
  const qty = floorToStep(quantity, rules?.stepSize);
  const price = floorToStep(takeProfit, rules?.tickSize);
  const stopPrice = floorToStep(stopLoss, rules?.tickSize);
  const stopLimitPrice = floorToStep(stopPrice * 0.999, rules?.tickSize);
  const qtyStr = toStepString(quantity, rules?.stepSize);
  const priceStr = toStepString(takeProfit, rules?.tickSize);
  const stopPriceStr = toStepString(stopLoss, rules?.tickSize);
  const stopLimitPriceStr = toStepString(stopPrice * 0.999, rules?.tickSize);

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
  const { data } = await client.cancelOCOOrder(symbol, { orderListId });
  return data;
};

export const placeOrder = async (params: TradeParams) => {
  if (!config.tradingEnabled) {
    throw new Error('Trading is disabled; set TRADING_ENABLED=true to place live orders.');
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

  const options =
    orderType === 'LIMIT'
      ? { timeInForce: 'GTC', quantity: adjustedQtyStr, price: adjustedPriceStr }
      : { quantity: adjustedQtyStr };

  const { data } = await client.newOrder(params.symbol, params.side, orderType, options);
  return data;
};
