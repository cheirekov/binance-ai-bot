import { Spot } from '@binance/connector';

import { config } from '../config.js';
import { logger } from '../logger.js';

const client = new Spot(config.binanceApiKey, config.binanceApiSecret, {
  baseURL: config.binanceBaseUrl,
});

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
}

export const fetchTradableSymbols = async (): Promise<SymbolInfo[]> => {
  try {
    const { data } = await client.exchangeInfo();
    return data.symbols.map(
      (s: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        status: string;
        isSpotTradingAllowed?: boolean;
        permissions?: string[];
      }) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        isSpotTradingAllowed: s.isSpotTradingAllowed,
        permissions: s.permissions,
      }),
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch exchange info');
    throw error;
  }
};
