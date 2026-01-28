import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  applyAiTuning,
  autoSelectSymbol,
  executeTrade,
  fetchOpenOrders,
  fetchOrderHistory,
  fetchStrategy,
  panicLiquidate,
  setEmergencyStop,
  startGrid,
  stopGrid,
  sweepUnused,
  triggerRefresh,
} from './api';
import { Balance, GridState, OrderRow, StrategyPlan, StrategyResponse } from './types';

const formatCompactNumber = (value: number, options?: { maxDecimals?: number }) => {
  const maxDecimals = options?.maxDecimals ?? 8;
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(6, maxDecimals) });
  if (abs >= 0.01) return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(8, maxDecimals) });
  // very small: show significant digits rather than rounding to 0.00
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
};

const formatPrice = (value: number | undefined, quoteAsset: string | undefined, digits = 8) => {
  if (value === undefined) return '—';
  const qa = quoteAsset?.toUpperCase();
  const fiatQuotes = ['USD', 'USDT', 'USDC', 'EUR', 'BUSD'];
  if (qa && fiatQuotes.includes(qa)) {
    const formatted = formatCompactNumber(value, { maxDecimals: 10 });
    if (qa === 'EUR') return `€${formatted}`;
    if (qa === 'USD') return `$${formatted}`;
    return `${formatted} ${qa}`;
  }
  return `${value.toFixed(digits)} ${qa ?? ''}`.trim();
};

const StrategyCard = ({ plan }: { plan: StrategyPlan }) => (
  <div className="card">
    <div className="card-header">
      <div>
        <p className="eyebrow">{plan.horizon.toUpperCase()}</p>
        <h3>{plan.thesis}</h3>
      </div>
      <span className="chip">RR {plan.riskRewardRatio.toFixed(2)}</span>
    </div>
    <div className="row">
      <div>
        <p className="label">Entry</p>
        <p className="value">
          {plan.entries[0].side} @ {plan.entries[0].priceTarget.toFixed(6)}
        </p>
        <p className="muted">
          Size {plan.entries[0].size.toFixed(4)} | Confidence {(plan.entries[0].confidence * 100).toFixed(0)}%
        </p>
      </div>
      <div>
        <p className="label">Stops/Targets</p>
        <p className="value">SL {plan.exitPlan.stopLoss.toFixed(6)}</p>
        <p className="muted">
          TP {plan.exitPlan.takeProfit.map((tp) => tp.toFixed(6)).join(' / ')} · {plan.exitPlan.timeframeMinutes}m
        </p>
      </div>
      <div>
        <p className="label">Signals</p>
        <ul className="signals">
          {plan.signalsUsed.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </div>
    {plan.aiNotes && <p className="ai-note">AI: {plan.aiNotes}</p>}
    <p className="muted">Est. fees {plan.estimatedFees.toFixed(4)}</p>
  </div>
);

const BalanceRow = ({ balance }: { balance: Balance }) => {
  const total = (balance.free ?? 0) + (balance.locked ?? 0);
  return (
    <div className="balance-row">
      <span className="mono">{balance.asset}</span>
      <span className="muted mono">
        {formatCompactNumber(total)} total · {formatCompactNumber(balance.free ?? 0)} free / {formatCompactNumber(balance.locked ?? 0)} locked
      </span>
    </div>
  );
};

function App() {
  const [data, setData] = useState<StrategyResponse | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState(() => localStorage.getItem('selectedSymbol') ?? '');
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') ?? 'overview');
  const [selectedPositionKey, setSelectedPositionKey] = useState<string | null>(null);
  const [balancesView, setBalancesView] = useState<'relevant' | 'all'>(() => (localStorage.getItem('balancesView') as 'relevant' | 'all') ?? 'relevant');
  const [balanceQuery, setBalanceQuery] = useState('');
  const [showDustBalances, setShowDustBalances] = useState(() => (localStorage.getItem('showDustBalances') ?? 'false') === 'true');
  const [ordersScope, setOrdersScope] = useState<'tracked' | 'viewing'>(() => (localStorage.getItem('ordersScope') as 'tracked' | 'viewing') ?? 'tracked');
  const [ordersView, setOrdersView] = useState<'open' | 'history'>(() => (localStorage.getItem('ordersView') as 'open' | 'history') ?? 'open');
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [openOrders, setOpenOrders] = useState<OrderRow[]>([]);
  const [orderHistory, setOrderHistory] = useState<OrderRow[]>([]);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [panicRunning, setPanicRunning] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [tuningRunning, setTuningRunning] = useState(false);
  const [gridRunning, setGridRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradeMessage, setTradeMessage] = useState<string | null>(null);
  const riskFlags = data?.riskFlags ?? [];

  const load = useCallback(async (symbol?: string) => {
    try {
      setLoading(true);
      const payload = await fetchStrategy(symbol ?? selectedSymbol);
      setData(payload);
      setSelectedSymbol(payload.symbol);
      if (payload.availableSymbols?.length) {
        const merged = payload.availableSymbols.includes(payload.symbol)
          ? payload.availableSymbols
          : [payload.symbol, ...payload.availableSymbols];
        setAvailableSymbols(merged);
      }
      setError(null);
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `API error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Unable to reach API. Check docker-compose and ports.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    void load(selectedSymbol);
    const interval = setInterval(() => void load(selectedSymbol), 25000);
    return () => clearInterval(interval);
  }, [load, selectedSymbol]);

  useEffect(() => {
    if (selectedSymbol) localStorage.setItem('selectedSymbol', selectedSymbol);
  }, [selectedSymbol]);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('balancesView', balancesView);
  }, [balancesView]);

  useEffect(() => {
    localStorage.setItem('showDustBalances', String(showDustBalances));
  }, [showDustBalances]);

  useEffect(() => {
    localStorage.setItem('ordersScope', ordersScope);
  }, [ordersScope]);

  useEffect(() => {
    localStorage.setItem('ordersView', ordersView);
  }, [ordersView]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const state = await triggerRefresh(selectedSymbol);
      setData(state);
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `Refresh error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Refresh failed. Try again.';
      setError(message);
    } finally {
      setRefreshing(false);
    }
  };

  const onAutoSelect = async () => {
    setRefreshing(true);
    try {
      const state = await autoSelectSymbol();
      setData(state);
      setSelectedSymbol(state.symbol);
      if (state.availableSymbols?.length) {
        const merged = state.availableSymbols.includes(state.symbol)
          ? state.availableSymbols
          : [state.symbol, ...state.availableSymbols];
        setAvailableSymbols(merged);
      }
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `Auto-select error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Auto-select failed. Try again.';
      setError(message);
    } finally {
      setRefreshing(false);
    }
  };

  const tradeQuantity = useMemo(() => {
    if (!data?.strategies) return 0;
    return Number(data.strategies.short.entries[0].size.toFixed(4));
  }, [data]);

  const simulateTrade = async (side: 'BUY' | 'SELL') => {
    setTradeMessage(null);
    try {
      const res = await executeTrade({
        side,
        quantity: tradeQuantity || 0.001,
        type: 'MARKET',
        symbol: selectedSymbol,
      });
      if (res.riskFlags) {
        setTradeMessage(`Trade halted: ${res.riskFlags.join('; ')}`);
      } else if (res.simulated) {
        setTradeMessage(res.note ?? 'Simulated trade; enable TRADING_ENABLED to go live.');
      } else {
        setTradeMessage('Order sent to Binance.');
      }
    } catch (err) {
      setTradeMessage('Trade failed. Check logs.');
    }
  };

  const onPanic = async () => {
    const home = data?.homeAsset ?? 'HOME_ASSET';
    const venue = data?.tradeVenue ?? 'spot';
    const confirmed = window.confirm(
      venue === 'futures'
        ? `Panic: this will MARKET-close all open futures positions (reduce-only).\n\nThis also enables Emergency Stop to prevent re-entry.\n\nContinue?`
        : `Panic liquidate: this will MARKET-SELL all free spot balances into ${home} where a direct market exists.\n\nThis also enables Emergency Stop to prevent re-entry.\n\nContinue?`,
    );
    if (!confirmed) return;

    setPanicRunning(true);
    setTradeMessage(null);
    try {
      const res = await panicLiquidate({ stopAutoTrade: true });
      const msg = `Panic complete: placed ${res.summary.placed}, skipped ${res.summary.skipped}, errors ${res.summary.errored}, still held ${res.summary.stillHeld}.`;
      setTradeMessage(msg);
      setData((prev) => (prev ? { ...prev, balances: res.balances, emergencyStop: res.emergencyStop } : prev));
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `Panic error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Panic failed. Check logs.';
      setError(message);
    } finally {
      setPanicRunning(false);
      void load(selectedSymbol);
    }
  };

  const onSweepUnused = async () => {
    const home = data?.homeAsset ?? 'HOME_ASSET';
    const venue = data?.tradeVenue ?? 'spot';
    if (venue !== 'spot') {
      setTradeMessage('Sweep unused is available only in spot mode.');
      return;
    }
    const confirmed = window.confirm(
      `Sweep unused: this will MARKET-SELL free balances (excluding HOME/allowed quotes/open-position assets) into ${home} where a direct market exists.\n\nLocked balances and open orders are not modified.\n\nContinue?`,
    );
    if (!confirmed) return;

    setSweepRunning(true);
    setTradeMessage(null);
    try {
      const res = await sweepUnused({ keepAllowedQuotes: true, keepPositionAssets: true, stopAutoTrade: false });
      const msg = `Sweep complete: placed ${res.summary.placed}, skipped ${res.summary.skipped}, errors ${res.summary.errored}, still held ${res.summary.stillHeld}.`;
      setTradeMessage(msg);
      setData((prev) => (prev ? { ...prev, balances: res.balances, emergencyStop: res.emergencyStop } : prev));
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `Sweep error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Sweep failed. Check logs.';
      setError(message);
    } finally {
      setSweepRunning(false);
      void load(selectedSymbol);
    }
  };

  const toggleEmergencyStop = async () => {
    const enabled = !(data?.emergencyStop ?? false);
    setRefreshing(true);
    setTradeMessage(null);
    try {
      await setEmergencyStop(enabled, enabled ? 'ui-toggle' : 'ui-clear');
      await load(selectedSymbol);
      setTradeMessage(enabled ? 'Emergency stop enabled.' : 'Emergency stop cleared.');
    } catch {
      setError('Failed to update emergency stop. Check logs.');
    } finally {
      setRefreshing(false);
    }
  };

  const onStartGrid = async () => {
    const venue = data?.tradeVenue ?? 'spot';
    if (venue !== 'spot') {
      setTradeMessage('Grid is available only in spot mode.');
      return;
    }
    const confirmed = window.confirm(
      `Start grid on ${selectedSymbol}: this will place multiple LIMIT buy/sell orders across an auto-derived range.\n\nGrid trading can lose money in trending markets.\n\nContinue?`,
    );
    if (!confirmed) return;
    setGridRunning(true);
    setTradeMessage(null);
    try {
      const res = await startGrid(selectedSymbol);
      if (!res.ok) {
        setError(res.error ?? 'Grid start failed. Check logs.');
      } else {
        setTradeMessage(`Grid started for ${selectedSymbol}.`);
      }
    } catch {
      setError('Grid start failed. Check logs.');
    } finally {
      setGridRunning(false);
      void load(selectedSymbol);
    }
  };

  const onStopGrid = async () => {
    const venue = data?.tradeVenue ?? 'spot';
    if (venue !== 'spot') {
      setTradeMessage('Grid is available only in spot mode.');
      return;
    }
    const confirmed = window.confirm(
      `Stop grid on ${selectedSymbol}: this will cancel bot-tracked grid orders for this symbol.\n\nIt will not liquidate holdings.\n\nContinue?`,
    );
    if (!confirmed) return;
    setGridRunning(true);
    setTradeMessage(null);
    try {
      const res = await stopGrid(selectedSymbol);
      if (!res.ok) {
        setError(res.error ?? 'Grid stop failed. Check logs.');
      } else {
        setTradeMessage(`Grid stopped for ${selectedSymbol}.`);
      }
    } catch {
      setError('Grid stop failed. Check logs.');
    } finally {
      setGridRunning(false);
      void load(selectedSymbol);
    }
  };

  const aiDecision = data?.aiPolicy?.lastDecision;
  const aiTune = aiDecision?.tune;
  const hasAiTune = !!aiTune && Object.keys(aiTune).length > 0;
  const aiWantsSweep = aiDecision?.sweepUnusedToHome ?? false;
  const tuneAlreadyApplied =
    hasAiTune && !!aiDecision && !!data?.runtimeConfig?.updatedAt && data.runtimeConfig.updatedAt >= aiDecision.at;

  const tuneSummary = useMemo(() => {
    if (!aiTune) return '';
    const parts: string[] = [];
    if (aiTune.minQuoteVolume !== undefined) parts.push(`MIN_QUOTE_VOLUME→${aiTune.minQuoteVolume.toLocaleString()}`);
    if (aiTune.maxVolatilityPercent !== undefined) parts.push(`MAX_VOLATILITY_PCT→${aiTune.maxVolatilityPercent}`);
    if (aiTune.autoTradeHorizon) parts.push(`AUTO_TRADE_HORIZON→${aiTune.autoTradeHorizon}`);
    if (aiTune.portfolioMaxAllocPct !== undefined) parts.push(`PORTFOLIO_MAX_ALLOC_PCT→${aiTune.portfolioMaxAllocPct}`);
    if (aiTune.portfolioMaxPositions !== undefined) parts.push(`PORTFOLIO_MAX_POSITIONS→${aiTune.portfolioMaxPositions}`);
    if (aiTune.gridMaxAllocPct !== undefined) parts.push(`GRID_MAX_ALLOC_PCT→${aiTune.gridMaxAllocPct}`);
    return parts.join(', ');
  }, [aiTune]);

  const runtimeSummary = useMemo(() => {
    const cfg = data?.runtimeConfig?.values;
    if (!cfg) return '';
    const parts: string[] = [];
    if (cfg.minQuoteVolume !== undefined) parts.push(`MIN_QUOTE_VOLUME=${cfg.minQuoteVolume.toLocaleString()}`);
    if (cfg.maxVolatilityPercent !== undefined) parts.push(`MAX_VOLATILITY_PCT=${cfg.maxVolatilityPercent}`);
    if (cfg.autoTradeHorizon) parts.push(`AUTO_TRADE_HORIZON=${cfg.autoTradeHorizon}`);
    if (cfg.portfolioMaxAllocPct !== undefined) parts.push(`PORTFOLIO_MAX_ALLOC_PCT=${cfg.portfolioMaxAllocPct}`);
    if (cfg.portfolioMaxPositions !== undefined) parts.push(`PORTFOLIO_MAX_POSITIONS=${cfg.portfolioMaxPositions}`);
    if (cfg.gridMaxAllocPct !== undefined) parts.push(`GRID_MAX_ALLOC_PCT=${cfg.gridMaxAllocPct}`);
    return parts.join(', ');
  }, [data?.runtimeConfig?.values]);

  const onApplyAiTuning = async () => {
    if (!hasAiTune || !aiDecision) return;
    const confirmed = window.confirm(
      `Apply AI tuning now?\n\nThis updates the bot's runtime settings immediately and persists them in state.json.\n\nSuggested: ${tuneSummary || '(none)'}\n\nContinue?`,
    );
    if (!confirmed) return;

    setTuningRunning(true);
    setTradeMessage(null);
    try {
      const res = await applyAiTuning();
      if (!res.ok) {
        setError(res.error ?? 'AI tuning apply failed. Check logs.');
      } else {
        setTradeMessage(`AI tuning applied: ${tuneSummary || 'ok'}`);
      }
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `AI tuning error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'AI tuning apply failed. Check logs.';
      setError(message);
    } finally {
      setTuningRunning(false);
      void load(selectedSymbol);
    }
  };

  const market = data?.market;
  const quote = market?.quoteAsset ?? data?.quoteAsset;
  const openPositions = useMemo(() => {
    const positions = Object.values(data?.positions ?? {});
    return positions.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  }, [data?.positions]);

  const openPositionRows = useMemo(() => {
    const entries = Object.entries(data?.positions ?? {});
    return entries
      .map(([key, p]) => ({ key, ...p }))
      .filter((p) => !!p.symbol)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  }, [data?.positions]);

  const selectedPosition = useMemo(() => {
    if (!selectedPositionKey) return null;
    const p = data?.positions?.[selectedPositionKey];
    if (!p) return null;
    return { key: selectedPositionKey, ...p };
  }, [data?.positions, selectedPositionKey]);

  const relevantAssets = useMemo(() => {
    const assets = new Set<string>();
    if (data?.homeAsset) assets.add(data.homeAsset.toUpperCase());
    if (data?.quoteAsset) assets.add(data.quoteAsset.toUpperCase());
    // Position assets
    for (const p of Object.values(data?.positions ?? {})) {
      if (!p) continue;
      if (p.baseAsset) assets.add(p.baseAsset.toUpperCase());
      if (p.quoteAsset) assets.add(p.quoteAsset.toUpperCase());
      if (p.homeAsset) assets.add(p.homeAsset.toUpperCase());
    }
    // Grid assets
    for (const g of Object.values(data?.grids ?? {})) {
      if (!g) continue;
      if (g.status !== 'running') continue;
      if (g.baseAsset) assets.add(g.baseAsset.toUpperCase());
      if (g.quoteAsset) assets.add(g.quoteAsset.toUpperCase());
      if (g.homeAsset) assets.add(g.homeAsset.toUpperCase());
    }
    return assets;
  }, [data?.grids, data?.homeAsset, data?.positions, data?.quoteAsset]);

  const filteredBalances = useMemo(() => {
    const balances = data?.balances ?? [];
    const query = balanceQuery.trim().toUpperCase();
    const home = data?.homeAsset?.toUpperCase();
    const minTotalToShow = showDustBalances ? 0 : 0.00000001;

    const rows = balances
      .map((b) => ({ ...b, asset: b.asset.toUpperCase() }))
      .filter((b) => (b.free ?? 0) + (b.locked ?? 0) > minTotalToShow)
      .filter((b) => (balancesView === 'all' ? true : relevantAssets.has(b.asset)))
      .filter((b) => (query ? b.asset.includes(query) : true))
      .sort((a, b) => (b.locked ?? 0) - (a.locked ?? 0) || (b.free ?? 0) - (a.free ?? 0) || a.asset.localeCompare(b.asset));

    // Always keep HOME visible in "relevant" mode.
    if (balancesView === 'relevant' && home) {
      const hasHome = rows.some((b) => b.asset === home);
      if (!hasHome) {
        const hb = balances.find((b) => b.asset.toUpperCase() === home);
        if (hb) rows.unshift({ ...hb, asset: home });
      }
    }
    return rows;
  }, [balanceQuery, balancesView, data?.balances, data?.homeAsset, relevantAssets, showDustBalances]);

  const modeHint = useMemo(() => {
    if (data?.aiPolicyMode && data.aiPolicyMode !== 'off') return 'policy';
    if (data?.gridEnabled && !data?.portfolioEnabled) return 'grid-only';
    if (data?.portfolioEnabled) return 'portfolio';
    return 'strategies';
  }, [data?.aiPolicyMode, data?.gridEnabled, data?.portfolioEnabled]);

  useEffect(() => {
    if (!localStorage.getItem('activeTab')) {
      setActiveTab(modeHint === 'policy' || modeHint === 'portfolio' ? 'positions' : 'overview');
    }
  }, [modeHint]);

  const trackedSymbols = useMemo(() => {
    const set = new Set<string>();
    if (data?.activeSymbol) set.add(data.activeSymbol.toUpperCase());
    for (const p of Object.values(data?.positions ?? {})) {
      if (!p?.symbol) continue;
      if (data?.tradeVenue && p.venue && p.venue !== data.tradeVenue) continue;
      set.add(p.symbol.toUpperCase());
    }
    for (const g of Object.values(data?.grids ?? {})) {
      if (!g) continue;
      if (g.status !== 'running') continue;
      set.add(g.symbol.toUpperCase());
    }
    return Array.from(set).slice(0, 12);
  }, [data?.activeSymbol, data?.grids, data?.positions, data?.tradeVenue]);

  const loadOrders = useCallback(async () => {
    if (!data) return;
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      if (ordersView === 'open') {
        const res = await fetchOpenOrders(
          ordersScope === 'viewing'
            ? { symbol: selectedSymbol.toUpperCase() }
            : { symbols: trackedSymbols.length ? trackedSymbols : undefined },
        );
        if (!res.ok) {
          setOrdersError('Failed to load open orders.');
        } else {
          setOpenOrders(res.openOrders ?? []);
        }
      } else {
        const sym = selectedSymbol.toUpperCase();
        const res = await fetchOrderHistory({ symbol: sym, limit: 80 });
        if (!res.ok) {
          setOrdersError('Failed to load order history.');
        } else {
          setOrderHistory(res.orders ?? []);
        }
      }
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'response' in err
          ? `Orders error ${(err as { response?: { status?: number; data?: { error?: string } } }).response?.status ?? ''}: ${
              (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Request failed'
            }`
          : 'Failed to load orders. Check API and logs.';
      setOrdersError(message);
    } finally {
      setOrdersLoading(false);
    }
  }, [data, ordersScope, ordersView, selectedSymbol, trackedSymbols]);

  useEffect(() => {
    if (activeTab !== 'orders') return;
    void loadOrders();
    const interval = setInterval(() => void loadOrders(), 20_000);
    return () => clearInterval(interval);
  }, [activeTab, loadOrders]);

  return (
    <div className="page">
      <div className="hero">
        <div>
          <p className="eyebrow">Binance AI Bot</p>
          <h1>Autonomous strategies across short, medium, and long horizons.</h1>
          <p className="muted">
            Live Binance telemetry, OpenAI-assisted thesis building, and guardrails for maker/taker
            fees. Keep TRADING_ENABLED=false until you are ready.
          </p>
          <div className="actions">
            <button className="btn primary" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh now'}
            </button>
            <button className="btn ghost" onClick={() => void load(selectedSymbol)} disabled={loading}>
              Sync status
            </button>
            <button className="btn soft" onClick={onAutoSelect} disabled={refreshing}>
              Auto-pick best
            </button>
          </div>
          <div className="actions">
            <label className="label" htmlFor="symbol-select">
              Symbol
            </label>
            <select
              id="symbol-select"
              className="select"
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
            >
              {(availableSymbols.length ? availableSymbols : [selectedSymbol]).map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          </div>
          {tradeMessage && <p className="muted">{tradeMessage}</p>}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="status-card">
          <p className="label">Bot status</p>
          <h2>{data?.status ?? 'Loading...'}</h2>
          <p className="muted">
            {data?.lastUpdated
              ? `Updated ${new Date(data.lastUpdated).toLocaleTimeString()}`
              : 'Waiting for first tick'}
          </p>
          {(data?.symbol ?? selectedSymbol) && (
            <p className="muted">
              Viewing symbol: <strong>{data?.symbol ?? selectedSymbol}</strong>
            </p>
          )}
          {(data?.autoTradeEnabled !== undefined || data?.tradingEnabled !== undefined) && (
            <p className="muted">
              Live trading: {data?.tradingEnabled ? 'on' : 'off'} · Auto-trade: {data?.autoTradeEnabled ? 'on' : 'off'}
            </p>
          )}
          {data?.tradeVenue && (
            <p className="muted">
              Venue: {data.tradeVenue}
              {data.tradeVenue === 'futures'
                ? ` · Futures: ${data.futuresEnabled ? 'on' : 'off'}${data.futuresLeverage ? ` · Leverage: ${data.futuresLeverage}x` : ''}`
                : ''}
            </p>
          )}
          {(data?.portfolioEnabled !== undefined || data?.conversionEnabled !== undefined) && (
            <p className="muted">
              Portfolio: {data?.portfolioEnabled ? `on (${data?.portfolioMaxAllocPct ?? '—'}% / ${data?.portfolioMaxPositions ?? '—'} pos)` : 'off'}
              {data?.conversionEnabled !== undefined
                ? ` · Conversions: ${
                    data.tradeVenue === 'futures' ? 'n/a (futures)' : data.conversionEnabled ? 'on' : 'off'
                  }`
                : ''}
              {data?.homeAsset ? ` · Home: ${data.homeAsset}` : ''}
            </p>
          )}
          {data?.gridEnabled !== undefined && (
            <p className="muted">
              Grid: {data.gridEnabled ? 'on' : 'off'}
              {data.gridEnabled ? ` (${data.gridMaxAllocPct ?? '—'}% / ${data.gridMaxActiveGrids ?? '—'} grids)` : ''}
              {data?.grids
                ? (() => {
                    const running = Object.values(data.grids).filter((g) => g.status === 'running');
                    return running.length ? ` · Active: ${running.map((g) => g.symbol).join(', ')}` : '';
                  })()
                : ''}
            </p>
          )}
          {data?.aiPolicyMode !== undefined && (
            <p className="muted">
              AI policy: {data.aiPolicyMode}
              {data.aiPolicy?.lastDecision
                ? ` · ${data.aiPolicy.lastDecision.action}${
                    data.aiPolicy.lastDecision.symbol ? ` ${data.aiPolicy.lastDecision.symbol}` : ''
                  }${data.aiPolicy.lastDecision.horizon ? ` (${data.aiPolicy.lastDecision.horizon})` : ''} · ${new Date(
                    data.aiPolicy.lastDecision.at,
                  ).toLocaleTimeString()} · ${(data.aiPolicy.lastDecision.confidence * 100).toFixed(0)}%`
                : ''}
            </p>
          )}
          {data?.aiPolicy?.lastDecision?.reason ? <p className="muted">AI: {data.aiPolicy.lastDecision.reason}</p> : null}
          {hasAiTune ? <p className="muted">AI tuning suggested: {tuneSummary}</p> : null}
          {aiWantsSweep ? (
            <p className="muted">
              AI suggests: sweep unused → {data?.homeAsset ?? 'HOME'} (you can run it via the button below)
            </p>
          ) : null}
          {data?.runtimeConfig?.values && runtimeSummary ? (
            <p className="muted">
              Runtime overrides: {runtimeSummary}
              {data.runtimeConfig.updatedAt ? ` · updated ${new Date(data.runtimeConfig.updatedAt).toLocaleTimeString()}` : ''}
              {data.runtimeConfig.source ? ` · ${data.runtimeConfig.source}` : ''}
            </p>
          ) : null}
          {data?.equity && (
            <p className="muted">
              Equity {data.equity.lastHome.toLocaleString(undefined, { maximumFractionDigits: 2 })} {data.equity.homeAsset} · PnL{' '}
              {(data.equity.pnlHome >= 0 ? '+' : '') + data.equity.pnlHome.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
              ({(data.equity.pnlPct >= 0 ? '+' : '') + data.equity.pnlPct.toFixed(2)}%) · since{' '}
              {new Date(data.equity.startAt).toLocaleTimeString()}
            </p>
          )}
          {data?.equity?.missingAssets?.length ? (
            <p className="muted">Unpriced assets: {data.equity.missingAssets.join(', ')}</p>
          ) : null}
          {data?.activeSymbol && (
            <p className="muted">
              Bot active symbol: <strong>{data.activeSymbol}</strong>
              {data.autoSelectUpdatedAt ? ` · picked ${new Date(data.autoSelectUpdatedAt).toLocaleTimeString()}` : ''}
              {data.symbol && data.activeSymbol.toUpperCase() !== data.symbol.toUpperCase() ? ` · viewing ${data.symbol}` : ''}
            </p>
          )}
          {openPositions.length > 0 && (
            <p className="muted">
              Open positions:{' '}
              {openPositions
                .map((p) => `${p.symbol.toUpperCase()} (${p.side === 'SELL' ? 'short' : 'long'}, ${p.horizon} horizon)`)
                .join(', ')}
            </p>
          )}
          {data?.emergencyStop !== undefined && (
            <p className="muted">
              Emergency stop: {data.emergencyStop ? 'on' : 'off'}
              {data.emergencyStopAt ? ` · ${new Date(data.emergencyStopAt).toLocaleTimeString()}` : ''}
              {data.emergencyStopReason ? ` · ${data.emergencyStopReason}` : ''}
            </p>
          )}
          {data?.lastAutoTrade && (
            <p className="muted">
              Auto-trade: {data.lastAutoTrade.action}
              {data.lastAutoTrade.horizon ? ` (${data.lastAutoTrade.horizon})` : ''} ·{' '}
              {new Date(data.lastAutoTrade.at).toLocaleTimeString()}
              {data.lastAutoTrade.reason ? ` · ${data.lastAutoTrade.reason}` : ''}
            </p>
          )}
          {riskFlags.length > 0 && (
            <div className="risk">
              <p className="label">Risk flags</p>
              <ul>
                {riskFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="status-actions">
            <button className="btn soft" onClick={() => simulateTrade('BUY')} disabled={data?.tradeHalted}>
              Sim buy {tradeQuantity || '—'}
            </button>
            <button className="btn soft" onClick={() => simulateTrade('SELL')} disabled={data?.tradeHalted}>
              Sim sell {tradeQuantity || '—'}
            </button>
            {hasAiTune && (
              <button className="btn soft" onClick={onApplyAiTuning} disabled={tuningRunning || tuneAlreadyApplied}>
                {tuningRunning ? 'Applying AI tuning…' : tuneAlreadyApplied ? 'AI tuning applied' : 'Apply AI tuning'}
              </button>
            )}
            <button className="btn soft" onClick={onSweepUnused} disabled={sweepRunning || data?.tradeVenue === 'futures'}>
              {sweepRunning ? 'Sweeping…' : `Sweep unused → ${data?.homeAsset ?? 'HOME'}`}
            </button>
            <button className="btn danger" onClick={onPanic} disabled={panicRunning}>
              {panicRunning
                ? 'Running…'
                : data?.tradeVenue === 'futures'
                  ? 'Panic: close futures'
                  : `Panic: liquidate to ${data?.homeAsset ?? 'HOME'}`}
            </button>
            <button className="btn soft" onClick={onStartGrid} disabled={gridRunning || data?.tradeVenue === 'futures'}>
              Start grid
            </button>
            <button className="btn soft" onClick={onStopGrid} disabled={gridRunning || data?.tradeVenue === 'futures'}>
              Stop grid
            </button>
            <button className="btn ghost" onClick={toggleEmergencyStop} disabled={refreshing}>
              {data?.emergencyStop ? 'Resume auto-trade' : 'Emergency stop'}
            </button>
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className={activeTab === 'overview' ? 'tab active' : 'tab'} onClick={() => setActiveTab('overview')}>
          Overview
        </button>
        <button className={activeTab === 'positions' ? 'tab active' : 'tab'} onClick={() => setActiveTab('positions')}>
          Positions
          {openPositionRows.length ? <span className="tab-badge">{openPositionRows.length}</span> : null}
        </button>
        <button className={activeTab === 'orders' ? 'tab active' : 'tab'} onClick={() => setActiveTab('orders')}>
          Orders
          {openOrders.length && activeTab !== 'orders' ? <span className="tab-badge">{openOrders.length}</span> : null}
        </button>
        <button
          className={activeTab === 'grid' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('grid')}
          disabled={data?.tradeVenue === 'futures'}
          title={data?.tradeVenue === 'futures' ? 'Grid is spot-only' : undefined}
        >
          Grid
        </button>
        <button className={activeTab === 'strategies' ? 'tab active' : 'tab'} onClick={() => setActiveTab('strategies')}>
          Strategies
        </button>
        <button className={activeTab === 'universe' ? 'tab active' : 'tab'} onClick={() => setActiveTab('universe')}>
          Universe
        </button>
      </div>

      {activeTab === 'overview' ? (
        <div className="panel-grid">
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Market</p>
                <h3>{market?.symbol ?? selectedSymbol}</h3>
              </div>
              {market ? (
                <span className={market.priceChangePercent >= 0 ? 'chip positive' : 'chip negative'}>
                  {market.priceChangePercent.toFixed(2)}%
                </span>
              ) : null}
            </div>
            {market ? (
              <div className="row">
                <div>
                  <p className="label">Price</p>
                  <p className="value">{formatPrice(market.price, quote)}</p>
                  <p className="muted">
                    High {formatCompactNumber(market.highPrice, { maxDecimals: 10 })} · Low {formatCompactNumber(market.lowPrice, { maxDecimals: 10 })}
                  </p>
                </div>
                <div>
                  <p className="label">Volume</p>
                  <p className="value">{formatCompactNumber(market.volume, { maxDecimals: 2 })}</p>
                  <p className="muted">Updated {new Date(market.updatedAt).toLocaleTimeString()}</p>
                </div>
              </div>
            ) : (
              <p className="muted">No market snapshot yet. Use “Refresh now”.</p>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Wallet</p>
                <h3>{data?.tradeVenue === 'futures' ? 'Futures balances' : 'Balances'}</h3>
              </div>
              <div className="header-actions">
                <select className="select small" value={balancesView} onChange={(e) => setBalancesView(e.target.value as 'relevant' | 'all')}>
                  <option value="relevant">Relevant</option>
                  <option value="all">All</option>
                </select>
              </div>
            </div>
            <div className="row">
              <div>
                <p className="muted">
                  Free = available to trade. Locked = reserved in open orders (OCO/grid/limits). Balances update on the last refresh tick for the viewed symbol.
                </p>
                <div className="actions">
                  <input
                    className="input"
                    placeholder="Filter assets… (e.g. TAO)"
                    value={balanceQuery}
                    onChange={(e) => setBalanceQuery(e.target.value)}
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showDustBalances}
                      onChange={(e) => setShowDustBalances(e.target.checked)}
                    />
                    <span>Show dust</span>
                  </label>
                </div>
              </div>
            </div>
            {filteredBalances.length ? (
              <div className="balance-list">
                {filteredBalances.map((balance) => (
                  <BalanceRow key={balance.asset} balance={balance} />
                ))}
              </div>
            ) : (
              <p className="muted">No balances to show (check keys, filters, and refresh).</p>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === 'positions' ? (
        <div className="panel-grid">
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Portfolio</p>
                <h3>Open positions</h3>
              </div>
              <span className="chip">{openPositionRows.length} open</span>
            </div>
            {openPositionRows.length ? (
              <div className="table">
                <div className="tr th">
                  <div>Symbol</div>
                  <div>Side</div>
                  <div>Horizon</div>
                  <div className="right">Size</div>
                  <div className="right">Entry</div>
                  <div className="right">SL</div>
                  <div className="right">TP</div>
                </div>
                {openPositionRows.map((p) => (
                  <button
                    key={p.key}
                    className={selectedPositionKey === p.key ? 'tr active' : 'tr'}
                    onClick={() => setSelectedPositionKey(p.key)}
                  >
                    <div className="mono">{p.symbol.toUpperCase()}</div>
                    <div className={p.side === 'SELL' ? 'negative' : 'positive'}>{p.side === 'SELL' ? 'SHORT' : 'LONG'}</div>
                    <div className="mono">{p.horizon}</div>
                    <div className="right mono">{formatCompactNumber(p.size ?? 0)}</div>
                    <div className="right mono">{formatCompactNumber(p.entryPrice ?? 0)}</div>
                    <div className="right mono">{p.stopLoss ? formatCompactNumber(p.stopLoss) : '—'}</div>
                    <div className="right mono">{p.takeProfit?.length ? p.takeProfit.map((x) => formatCompactNumber(x)).join(' / ') : '—'}</div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">No open positions tracked in state.json.</p>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Details</p>
                <h3>{selectedPosition ? selectedPosition.symbol.toUpperCase() : 'Select a position'}</h3>
              </div>
              {selectedPosition ? (
                <button className="btn soft" onClick={() => setSelectedSymbol(selectedPosition.symbol.toUpperCase())}>
                  View symbol
                </button>
              ) : null}
            </div>
            {selectedPosition ? (
              <div className="row">
                <div>
                  <p className="label">Opened</p>
                  <p className="value">{new Date(selectedPosition.openedAt).toLocaleString()}</p>
                  <p className="muted mono">
                    Key {selectedPosition.key}
                    {selectedPosition.ocoOrderListId ? ` · OCO ${selectedPosition.ocoOrderListId}` : ''}
                    {selectedPosition.venue ? ` · ${selectedPosition.venue}` : ''}
                    {selectedPosition.leverage ? ` · ${selectedPosition.leverage}x` : ''}
                  </p>
                </div>
                <div>
                  <p className="label">AI policy</p>
                  {aiDecision ? (
                    <>
                      <p className="value">
                        {aiDecision.action} · {(aiDecision.confidence * 100).toFixed(0)}%
                      </p>
                      <p className="muted">
                        {aiDecision.positionKey && aiDecision.positionKey === selectedPosition.key
                          ? `This decision targets the selected position.`
                          : `Last decision: ${new Date(aiDecision.at).toLocaleTimeString()}`}
                      </p>
                      <p className="muted">AI: {aiDecision.reason}</p>
                    </>
                  ) : (
                    <p className="muted">AI policy is off or no decision yet.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="muted">Click a position to see details and the latest AI policy reasoning.</p>
            )}

            {data?.strategies && selectedPosition && selectedSymbol.toUpperCase() === selectedPosition.symbol.toUpperCase() ? (
              <div className="row">
                <div>
                  <p className="label">Strategy context (for the viewed symbol)</p>
                  <p className="muted">
                    In AI policy modes, strategies are informational. The policy decides OPEN/CLOSE/HOLD/PANIC; the engine enforces guardrails.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'grid' ? (
        <div className="panel-grid">
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Grid</p>
                <h3>Active grids</h3>
              </div>
              <span className="chip">
                {Object.values(data?.grids ?? {}).filter((g) => g.status === 'running').length} running
              </span>
            </div>
            {data?.tradeVenue === 'futures' ? (
              <p className="muted">Grid mode is spot-only.</p>
            ) : null}

            {Object.values(data?.grids ?? {}).filter((g) => g.status === 'running').length ? (
              <div className="grid-list">
                {Object.values(data?.grids ?? {})
                  .filter((g) => g.status === 'running')
                  .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                  .map((g: GridState) => (
                    <div key={g.symbol} className="grid-item">
                      <div className="grid-item-head">
                        <div>
                          <div className="mono">{g.symbol}</div>
                          <div className="muted">
                            Range {formatCompactNumber(g.lowerPrice)} → {formatCompactNumber(g.upperPrice)} · levels {g.levels} · alloc{' '}
                            {formatCompactNumber(g.allocationHome)} {g.homeAsset}
                          </div>
                        </div>
                        {g.performance ? (
                          <div className={g.performance.pnlHome >= 0 ? 'mono positive' : 'mono negative'}>
                            {(g.performance.pnlHome >= 0 ? '+' : '') + formatCompactNumber(g.performance.pnlHome)} {g.homeAsset} ·{' '}
                            {(g.performance.pnlPct >= 0 ? '+' : '') + g.performance.pnlPct.toFixed(2)}%
                          </div>
                        ) : (
                          <div className="muted">No performance yet</div>
                        )}
                      </div>
                      {g.performance ? (
                        <div className="muted">
                          Value {formatCompactNumber(g.performance.lastValueHome)} · fees~{formatCompactNumber(g.performance.feesHome)} · fills buy/sell{' '}
                          {g.performance.fillsBuy}/{g.performance.fillsSell} · breakouts {g.performance.breakouts}
                        </div>
                      ) : null}
                    </div>
                  ))}
              </div>
            ) : (
              <p className="muted">No running grids. Use “Start grid” or enable auto-grid discovery.</p>
            )}

            {data?.rankedGridCandidates?.length ? (
              <details className="details">
                <summary>Top grid candidates (heuristic)</summary>
                <ul className="signals">
                  {data.rankedGridCandidates.slice(0, 10).map((c) => (
                    <li key={c.symbol}>
                      {c.symbol}: {c.score.toFixed(2)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'orders' ? (
        <div className="panel-grid">
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Orders</p>
                <h3>{ordersView === 'open' ? 'Open orders' : 'Order history'}</h3>
              </div>
              <div className="header-actions">
                <select className="select small" value={ordersView} onChange={(e) => setOrdersView(e.target.value as 'open' | 'history')}>
                  <option value="open">Open</option>
                  <option value="history">History</option>
                </select>
                <select className="select small" value={ordersScope} onChange={(e) => setOrdersScope(e.target.value as 'tracked' | 'viewing')} disabled={ordersView === 'history'}>
                  <option value="tracked">Tracked</option>
                  <option value="viewing">Viewing</option>
                </select>
                <button className="btn soft" onClick={() => void loadOrders()} disabled={ordersLoading}>
                  {ordersLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>
            </div>
            {ordersError ? <p className="error">{ordersError}</p> : null}
            {ordersView === 'history' ? (
              <p className="muted">History is shown for the currently viewed symbol ({selectedSymbol.toUpperCase()}).</p>
            ) : (
              <p className="muted">
                Scope: {ordersScope === 'tracked' ? `tracked symbols (${trackedSymbols.join(', ') || 'none'})` : `viewing ${selectedSymbol.toUpperCase()}`}.
              </p>
            )}

            {ordersView === 'open' ? (
              openOrders.length ? (
                <div className="table">
                  <div className="tr th tr-orders">
                    <div>Pair</div>
                    <div>Type</div>
                    <div>Side</div>
                    <div className="right">Price</div>
                    <div className="right">Amount</div>
                    <div className="right">Filled</div>
                    <div className="right">Total</div>
                    <div className="right">Updated</div>
                  </div>
                  {openOrders.map((o) => {
                    const filledPct = o.origQty > 0 ? (o.executedQty / o.origQty) * 100 : 0;
                    const total = o.cummulativeQuoteQty > 0 ? o.cummulativeQuoteQty : o.price * o.origQty;
                    const isExpanded = expandedOrderId === o.orderId;
                    const source = o.bot?.source ?? 'unknown';
                    return (
                      <div key={`${o.symbol}-${o.orderId}`}>
                        <button
                          className={isExpanded ? 'tr tr-orders active' : 'tr tr-orders'}
                          onClick={() => setExpandedOrderId(isExpanded ? null : o.orderId)}
                        >
                          <div className="mono">{o.symbol}</div>
                          <div className="mono">{o.type}</div>
                          <div className={o.side === 'SELL' ? 'negative' : 'positive'}>{o.side}</div>
                          <div className="right mono">{o.price > 0 ? formatCompactNumber(o.price) : '—'}</div>
                          <div className="right mono">{formatCompactNumber(o.origQty)}</div>
                          <div className="right mono">{filledPct > 0 ? `${filledPct.toFixed(0)}%` : '0%'}</div>
                          <div className="right mono">{total > 0 ? formatCompactNumber(total) : '—'}</div>
                          <div className="right mono">{new Date((o.updateTime || o.time) ?? 0).toLocaleTimeString()}</div>
                        </button>
                        {isExpanded ? (
                          <div className="order-expand">
                            <div className="muted">
                              Status <span className="mono">{o.status}</span> · OrderId <span className="mono">{o.orderId}</span>
                              {o.stopPrice ? ` · Stop ${formatCompactNumber(o.stopPrice)}` : ''}{' '}
                              {o.timeInForce ? ` · TIF ${o.timeInForce}` : ''}
                            </div>
                            <div className="muted">
                              Bot source: <span className="mono">{source}</span>
                              {o.bot?.gridSymbol ? ` · grid ${o.bot.gridSymbol} level ${o.bot.gridLevel}` : ''}
                              {o.bot?.positionKey ? ` · position ${o.bot.positionKey}` : ''}
                              {o.bot?.ocoOrderListId ? ` · OCO ${o.bot.ocoOrderListId}` : ''}
                            </div>
                            {o.bot?.ai ? (
                              <div className="ai-note">
                                <div className="mono">
                                  AI policy: {o.bot.ai.action} · {(o.bot.ai.confidence * 100).toFixed(0)}% · {new Date(o.bot.ai.at).toLocaleTimeString()}
                                </div>
                                <div>{o.bot.ai.reason}</div>
                              </div>
                            ) : (
                              <div className="muted">
                                {data?.aiPolicyMode && data.aiPolicyMode !== 'off'
                                  ? 'No AI decision is linked to this order (it may be a grid level, an engine exit, or an external/manual order).'
                                  : 'AI policy is off; orders are driven by the engine (or manual/external).'}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">No open orders.</p>
              )
            ) : orderHistory.length ? (
              <div className="table">
                <div className="tr th tr-orders">
                  <div>Pair</div>
                  <div>Status</div>
                  <div>Side</div>
                  <div className="right">Price</div>
                  <div className="right">Amount</div>
                  <div className="right">Filled</div>
                  <div className="right">Total</div>
                  <div className="right">Time</div>
                </div>
                {orderHistory.map((o) => {
                  const total = o.cummulativeQuoteQty > 0 ? o.cummulativeQuoteQty : o.price * o.executedQty;
                  const isExpanded = expandedOrderId === o.orderId;
                  return (
                    <div key={`${o.symbol}-${o.orderId}`}>
                      <button className={isExpanded ? 'tr tr-orders active' : 'tr tr-orders'} onClick={() => setExpandedOrderId(isExpanded ? null : o.orderId)}>
                        <div className="mono">{o.symbol}</div>
                        <div className="mono">{o.status}</div>
                        <div className={o.side === 'SELL' ? 'negative' : 'positive'}>{o.side}</div>
                        <div className="right mono">{o.price > 0 ? formatCompactNumber(o.price) : '—'}</div>
                        <div className="right mono">{formatCompactNumber(o.origQty)}</div>
                        <div className="right mono">{formatCompactNumber(o.executedQty)}</div>
                        <div className="right mono">{total > 0 ? formatCompactNumber(total) : '—'}</div>
                        <div className="right mono">{new Date((o.updateTime || o.time) ?? 0).toLocaleTimeString()}</div>
                      </button>
                      {isExpanded ? (
                        <div className="order-expand">
                          <div className="muted">
                            Type <span className="mono">{o.type}</span> · OrderId <span className="mono">{o.orderId}</span>
                            {o.stopPrice ? ` · Stop ${formatCompactNumber(o.stopPrice)}` : ''}{' '}
                            {o.timeInForce ? ` · TIF ${o.timeInForce}` : ''}
                          </div>
                          <div className="muted">
                            Bot source: <span className="mono">{o.bot?.source ?? 'unknown'}</span>
                            {o.bot?.gridSymbol ? ` · grid ${o.bot.gridSymbol} level ${o.bot.gridLevel}` : ''}
                            {o.bot?.positionKey ? ` · position ${o.bot.positionKey}` : ''}
                            {o.bot?.ocoOrderListId ? ` · OCO ${o.bot.ocoOrderListId}` : ''}
                          </div>
                          {o.bot?.ai ? (
                            <div className="ai-note">
                              <div className="mono">
                                AI policy: {o.bot.ai.action} · {(o.bot.ai.confidence * 100).toFixed(0)}% · {new Date(o.bot.ai.at).toLocaleTimeString()}
                              </div>
                              <div>{o.bot.ai.reason}</div>
                            </div>
                          ) : (
                            <div className="muted">No linked AI decision for this order.</div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">No orders in history for {selectedSymbol.toUpperCase()} (or Binance returned none).</p>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === 'strategies' ? (
        <div className="strategies">
          {data?.aiPolicyMode && data.aiPolicyMode !== 'off' ? (
            <div className="card">
              <p className="muted">
                AI policy mode is <span className="mono">{data.aiPolicyMode}</span>. These strategies are informational; entries/exits are gated by the
                policy + engine guardrails.
              </p>
            </div>
          ) : null}
          {data?.strategies ? (
            [
              { key: 'short', plan: data.strategies.short },
              { key: 'medium', plan: data.strategies.medium },
              { key: 'long', plan: data.strategies.long },
            ].map(({ key, plan }) => <StrategyCard key={key} plan={plan} />)
          ) : (
            <p className="muted">
              {data?.status === 'refreshing'
                ? 'Refreshing strategy...'
                : data?.status === 'error'
                  ? `Refresh failed: ${data.error ?? 'Unknown error'}`
                  : `No strategy yet for ${selectedSymbol}. Waiting for first refresh...`}
            </p>
          )}
        </div>
      ) : null}

      {activeTab === 'universe' ? (
        <div className="panel-grid">
          {data?.rankedCandidates?.length ? (
            <div className="card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Universe</p>
                  <h3>Top candidates (score)</h3>
                </div>
              </div>
              <div className="row">
                <ul className="signals">
                  {data.rankedCandidates.slice(0, 20).map((c) => (
                    <li key={c.symbol}>
                      {c.symbol}: {c.score.toFixed(2)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="muted">No universe ranking yet. Enable auto-discovery and wait for a refresh tick.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default App;
