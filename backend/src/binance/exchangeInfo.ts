import { Spot } from '@binance/connector';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';

const client = new Spot(config.binanceApiKey, config.binanceApiSecret, {
  baseURL: config.binanceBaseUrl,
});

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset?: string;
  contractType?: string;
  status: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
  tickSize?: number;
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
}

let cache:
  | {
      fetchedAt: number;
      symbols: SymbolInfo[];
    }
  | null = null;

export const fetchTradableSymbols = async (): Promise<SymbolInfo[]> => {
  const ttlMs = 10 * 60 * 1000;
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ttlMs) return cache.symbols;

  try {
    if (config.tradeVenue === 'futures') {
      const url = `${config.futuresBaseUrl}/fapi/v1/exchangeInfo`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Futures exchangeInfo failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        symbols: Array<{
          symbol: string;
          baseAsset: string;
          quoteAsset: string;
          marginAsset?: string;
          contractType?: string;
          status: string;
          filters?: { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string; minNotional?: string }[];
        }>;
      };
      const symbols = data.symbols.map((s) => {
        const lot = s.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE') ?? s.filters?.find((f) => f.filterType === 'LOT_SIZE');
        const minNotional = s.filters?.find((f) => f.filterType === 'MIN_NOTIONAL');
        return {
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          marginAsset: s.marginAsset,
          contractType: s.contractType,
          status: s.status,
          tickSize: Number(s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0) || undefined,
          stepSize: Number(lot?.stepSize ?? 0) || undefined,
          minQty: Number(lot?.minQty ?? 0) || undefined,
          minNotional: Number(minNotional?.notional ?? minNotional?.minNotional ?? 0) || undefined,
        } satisfies SymbolInfo;
      });
      cache = { fetchedAt: now, symbols };
      return symbols;
    }

    const { data } = await client.exchangeInfo();
    const symbols = data.symbols.map(
      (s: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        status: string;
        isSpotTradingAllowed?: boolean;
        permissions?: string[];
        filters?: { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; minNotional?: string; notional?: string }[];
      }) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        isSpotTradingAllowed: s.isSpotTradingAllowed,
        permissions: s.permissions,
        tickSize: Number(s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0) || undefined,
        stepSize: Number(s.filters?.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? 0) || undefined,
        minQty: Number(s.filters?.find((f) => f.filterType === 'LOT_SIZE')?.minQty ?? 0) || undefined,
        minNotional:
          Number(
            s.filters?.find((f) => f.filterType === 'MIN_NOTIONAL')?.minNotional ??
              s.filters?.find((f) => f.filterType === 'NOTIONAL')?.minNotional ??
              0,
          ) || undefined,
      }),
    );
    cache = { fetchedAt: now, symbols };
    return symbols;
  } catch (error) {
    logger.error({ err: errorToLogObject(error) }, 'Failed to fetch exchange info');
    throw error;
  }
};
