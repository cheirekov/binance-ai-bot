import axios from 'axios';

import { StrategyResponse } from './types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:8788',
  timeout: 10000,
});

export const fetchStrategy = async () => {
  const { data } = await api.get<StrategyResponse>('/strategy');
  return data;
};

export const triggerRefresh = async () => {
  const { data } = await api.post('/strategy/refresh');
  return data.state as StrategyResponse;
};

export const executeTrade = async (params: {
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  type?: 'MARKET' | 'LIMIT';
}) => {
  const { data } = await api.post('/trade/execute', params);
  return data;
};
