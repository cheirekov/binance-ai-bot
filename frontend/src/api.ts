import axios from 'axios';

import { PanicLiquidateResponse, StrategyResponse, SweepUnusedResponse } from './types';

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
