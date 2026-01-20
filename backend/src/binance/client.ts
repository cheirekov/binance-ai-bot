import { Spot } from '@binance/connector';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { Balance, MarketSnapshot } from '../types.js';

const client = new Spot(config.binanceApiKey, config.binanceApiSecret, {
  baseURL: config.binanceBaseUrl,
});

export const get24hStats = async (symbol: string): Promise<MarketSnapshot> => {
  const { data } = await client.ticker24hr(symbol);
  return {
    symbol: data.symbol,
    price: Number(data.lastPrice),
    priceChangePercent: Number(data.priceChangePercent),
    highPrice: Number(data.highPrice),
    lowPrice: Number(data.lowPrice),
    volume: Number(data.volume),
    // quoteVolume gives liquidity in quote asset (USDT/USDC/EUR)
    // Some tickers may not return it; default to 0 if missing
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
    logger.warn({ err: error }, 'Unable to fetch balances (likely using public-only keys)');
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
  const stopLimitPrice = side === 'BUY' ? stopLoss * 1.001 : stopLoss * 0.999;
  const params = {
    symbol,
    side,
    quantity,
    price: takeProfit,
    stopPrice: stopLoss,
    stopLimitPrice,
    stopLimitTimeInForce: 'GTC',
  };
  const { data } = await client.newOCOOrder(params as {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    stopPrice: number;
    stopLimitPrice: number;
    stopLimitTimeInForce: string;
  });
  return data;
};

export const placeOrder = async (params: TradeParams) => {
  if (!config.tradingEnabled) {
    throw new Error('Trading is disabled; set TRADING_ENABLED=true to place live orders.');
  }

  const orderType = params.type ?? 'MARKET';
  const payload =
    orderType === 'LIMIT'
      ? {
          symbol: params.symbol,
          side: params.side,
          type: orderType,
          timeInForce: 'GTC',
          quantity: params.quantity,
          price: params.price,
        }
      : {
          symbol: params.symbol,
          side: params.side,
          type: orderType,
          quantity: params.quantity,
        };

  const { data } = await client.newOrder(payload);
  return data;
};
