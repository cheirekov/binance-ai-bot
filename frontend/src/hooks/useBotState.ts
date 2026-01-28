import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { autoSelectSymbol, fetchStrategy, triggerRefresh } from '../api';
import { StrategyResponse } from '../types';
import { readStorage, writeStorage } from '../utils/storage';

type ApiHealth =
  | { status: 'idle' }
  | { status: 'ok'; lastSuccessAt: number }
  | { status: 'error'; lastErrorAt: number; lastErrorMessage: string; lastSuccessAt?: number };

export type BotState = {
  data: StrategyResponse | null;
  loading: boolean;
  error: string | null;
  selectedSymbol: string;
  availableSymbols: string[];
  lastSuccessAt: number | null;
  apiHealth: ApiHealth;
  sync: () => Promise<void>;
  refreshNow: () => Promise<void>;
  autoPickBest: () => Promise<void>;
  setSelectedSymbol: (symbol: string) => void;
};

const mergeSymbols = (payload: StrategyResponse): string[] => {
  const current = payload.symbol;
  const list = payload.availableSymbols ?? [];
  if (!current) return list;
  if (list.includes(current)) return list;
  return [current, ...list];
};

const toErrorMessage = (err: unknown) => {
  if (typeof err === 'object' && err && 'response' in err) {
    const rec = err as { response?: { status?: number; data?: { error?: string } } };
    const status = rec.response?.status;
    const msg = rec.response?.data?.error ?? 'Request failed';
    return `API error${status ? ` ${status}` : ''}: ${msg}`;
  }
  return 'Unable to reach API. Check docker-compose and ports.';
};

export const useBotState = (options?: { pollMs?: number }): BotState => {
  const pollMs = options?.pollMs ?? 25_000;
  const [data, setData] = useState<StrategyResponse | null>(null);
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState(() => readStorage('selectedSymbol') ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiHealth, setApiHealth] = useState<ApiHealth>({ status: 'idle' });
  const lastSuccessAt = useMemo(() => (apiHealth.status === 'ok' ? apiHealth.lastSuccessAt : apiHealth.status === 'error' ? apiHealth.lastSuccessAt ?? null : null), [apiHealth]);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (symbol?: string, mode: 'sync' | 'refresh' | 'autoPick' | 'poll' = 'sync') => {
      if (inFlight.current) return inFlight.current;
      const task = (async () => {
        const sym = symbol ?? selectedSymbol;
        const shouldShowLoading = mode === 'sync' && !data;
        if (shouldShowLoading) setLoading(true);
        try {
          const payload =
            mode === 'refresh'
              ? await triggerRefresh(sym)
              : mode === 'autoPick'
                ? await autoSelectSymbol()
                : await fetchStrategy(sym || undefined);

          if (!mounted.current) return;
          setData(payload);
          if (payload.symbol) setSelectedSymbol(payload.symbol);
          const merged = mergeSymbols(payload);
          setAvailableSymbols(merged);
          setError(null);
          const now = Date.now();
          setApiHealth({ status: 'ok', lastSuccessAt: now });
        } catch (err) {
          if (!mounted.current) return;
          const msg = toErrorMessage(err);
          setError(msg);
          const now = Date.now();
          setApiHealth((prev) =>
            prev.status === 'ok'
              ? { status: 'error', lastErrorAt: now, lastErrorMessage: msg, lastSuccessAt: prev.lastSuccessAt }
              : { status: 'error', lastErrorAt: now, lastErrorMessage: msg, lastSuccessAt: prev.status === 'error' ? prev.lastSuccessAt : undefined },
          );
        } finally {
          inFlight.current = null;
          if (mounted.current) setLoading(false);
        }
      })();
      inFlight.current = task;
      return task;
    },
    [data, selectedSymbol],
  );

  const sync = useCallback(async () => load(selectedSymbol, 'sync'), [load, selectedSymbol]);
  const refreshNow = useCallback(async () => load(selectedSymbol, 'refresh'), [load, selectedSymbol]);
  const autoPickBest = useCallback(async () => load(undefined, 'autoPick'), [load]);

  useEffect(() => {
    writeStorage('selectedSymbol', selectedSymbol);
  }, [selectedSymbol]);

  useEffect(() => {
    void load(selectedSymbol, 'sync');
    const interval = window.setInterval(() => void load(selectedSymbol, 'poll'), pollMs);
    return () => window.clearInterval(interval);
  }, [load, pollMs, selectedSymbol]);

  useEffect(() => {
    if (!data?.symbol) return;
    if (data.symbol === selectedSymbol) return;
    void load(data.symbol, 'sync');
  }, [data?.symbol, load, selectedSymbol]);

  const onSetSelectedSymbol = useCallback(
    (symbol: string) => {
      setSelectedSymbol(symbol);
      void load(symbol, 'sync');
    },
    [load],
  );

  return {
    data,
    loading,
    error,
    selectedSymbol,
    availableSymbols: availableSymbols.length ? availableSymbols : selectedSymbol ? [selectedSymbol] : [],
    lastSuccessAt,
    apiHealth,
    sync,
    refreshNow,
    autoPickBest,
    setSelectedSymbol: onSetSelectedSymbol,
  };
};
