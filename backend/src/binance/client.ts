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
    updatedAt: Date.now(),
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
