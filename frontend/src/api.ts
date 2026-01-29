import axios from 'axios';

import {
  DbStatsResponse,
  OpenOrdersResponse,
  OrderHistoryResponse,
  PanicLiquidateResponse,
  PerformanceStatsResponse,
  PnlReconcileResponse,
  StrategyResponse,
  SweepUnusedResponse,
} from './types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:8788',
  timeout: 10000,
  headers: import.meta.env.VITE_CLIENT_KEY ? { 'x-api-key': import.meta.env.VITE_CLIENT_KEY } : {},
});

export const fetchStrategy = async (symbol?: string) => {
  const { data } = await api.get<StrategyResponse>('/strategy', {
    params: symbol ? { symbol } : undefined,
  });
  return data;
};

export const triggerRefresh = async (symbol?: string) => {
  const { data } = await api.post('/strategy/refresh', undefined, {
    params: symbol ? { symbol } : undefined,
  });
  return data.state as StrategyResponse;
};

export const autoSelectSymbol = async () => {
  const { data } = await api.post('/strategy/auto-select');
  return data.state as StrategyResponse;
};

export const executeTrade = async (params: {
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  type?: 'MARKET' | 'LIMIT';
  symbol?: string;
}) => {
  const { data } = await api.post('/trade/execute', params);
  return data;
};

export const panicLiquidate = async (params?: { dryRun?: boolean; stopAutoTrade?: boolean }) => {
  const { data } = await api.post<PanicLiquidateResponse>('/portfolio/panic-liquidate', params ?? {});
  return data;
};

export const sweepUnused = async (params?: {
  dryRun?: boolean;
  stopAutoTrade?: boolean;
  keepAllowedQuotes?: boolean;
  keepPositionAssets?: boolean;
  keepAssets?: string[];
}) => {
  const { data } = await api.post<SweepUnusedResponse>('/portfolio/sweep-unused', params ?? {});
  return data;
};

export const setEmergencyStop = async (enabled: boolean, reason?: string) => {
  const { data } = await api.post('/bot/emergency-stop', { enabled, reason });
  return data as { ok: boolean; enabled: boolean; at: number };
};

export const startGrid = async (symbol: string) => {
  const { data } = await api.post('/grid/start', { symbol });
  return data as { ok: boolean; error?: string };
};

export const stopGrid = async (symbol: string) => {
  const { data } = await api.post('/grid/stop', { symbol });
  return data as { ok: boolean; error?: string };
};

export const applyAiTuning = async (params?: { dryRun?: boolean }) => {
  const { data } = await api.post('/ai-policy/apply-tuning', params ?? {});
  return data as { ok: boolean; at?: number; applied?: Record<string, unknown>; wouldApply?: Record<string, unknown>; error?: string };
};

export const fetchOpenOrders = async (params?: { symbol?: string; symbols?: string[] }) => {
  const { data } = await api.get<OpenOrdersResponse>('/orders/open', {
    params: params?.symbol
      ? { symbol: params.symbol }
      : params?.symbols?.length
        ? { symbols: params.symbols.join(',') }
        : undefined,
  });
  return data;
};

export const fetchOrderHistory = async (params: { symbol: string; limit?: number }) => {
  const { data } = await api.get<OrderHistoryResponse>('/orders/history', {
    params: { symbol: params.symbol, limit: params.limit ?? 50 },
  });
  return data;
};

export const fetchPerformanceStatsOptional = async (): Promise<PerformanceStatsResponse | null> => {
  try {
    const { data } = await api.get<PerformanceStatsResponse>('/stats/performance');
    return data;
  } catch (err) {
    const status =
      typeof err === 'object' && err && 'response' in err
        ? (err as { response?: { status?: number } }).response?.status
        : undefined;
    // Optional endpoint: hide silently on 404 or any error.
    if (status === 404) return null;
    return null;
  }
};

export const fetchDbStatsOptional = async (): Promise<DbStatsResponse | null> => {
  try {
    const { data } = await api.get<DbStatsResponse>('/stats/db');
    if (!data?.persistToSqlite) return null;
    return data;
  } catch (err) {
    const status =
      typeof err === 'object' && err && 'response' in err
        ? (err as { response?: { status?: number } }).response?.status
        : undefined;
    if (status === 404) return null;
    return null;
  }
};

export const fetchPnlReconcileOptional = async (params?: { window?: string }): Promise<PnlReconcileResponse | null> => {
  try {
    const { data } = await api.get<PnlReconcileResponse>('/stats/pnl_reconcile', {
      params: params?.window ? { window: params.window } : undefined,
    });
    return data;
  } catch (err) {
    const status =
      typeof err === 'object' && err && 'response' in err
        ? (err as { response?: { status?: number } }).response?.status
        : undefined;
    if (status === 404) return null;
    return null;
  }
};
