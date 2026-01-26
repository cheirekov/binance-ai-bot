import { useCallback, useEffect, useMemo, useState } from 'react';

import { autoSelectSymbol, executeTrade, fetchStrategy, panicLiquidate, setEmergencyStop, sweepUnused, triggerRefresh } from './api';
import { Balance, StrategyPlan, StrategyResponse } from './types';

const formatPrice = (value: number | undefined, quoteAsset: string | undefined, digits = 8) => {
  if (value === undefined) return '—';
  const qa = quoteAsset?.toUpperCase();
  const fiatQuotes = ['USD', 'USDT', 'USDC', 'EUR', 'BUSD'];
  if (qa && fiatQuotes.includes(qa)) {
    if (qa === 'EUR') return `€${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (qa === 'USD') return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${qa}`;
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

const BalanceRow = ({ balance }: { balance: Balance }) => (
  <div className="balance-row">
    <span>{balance.asset}</span>
    <span className="muted">
      {balance.free} free / {balance.locked} locked
    </span>
  </div>
);

function App() {
  const [data, setData] = useState<StrategyResponse | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState(() => localStorage.getItem('selectedSymbol') ?? '');
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [panicRunning, setPanicRunning] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);
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

  const market = data?.market;
  const quote = market?.quoteAsset ?? data?.quoteAsset;
  const openPositions = useMemo(() => {
    const positions = Object.values(data?.positions ?? {});
    return positions.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  }, [data?.positions]);

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
                .map((p) => `${p.symbol.toUpperCase()} (${p.side === 'SELL' ? 'short' : 'long'} · ${p.horizon})`)
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
            <button className="btn ghost" onClick={toggleEmergencyStop} disabled={refreshing}>
              {data?.emergencyStop ? 'Resume auto-trade' : 'Emergency stop'}
            </button>
          </div>
        </div>
      </div>

      {market && (
        <div className="market">
          <div className="market-card">
            <div>
              <p className="label">{market.symbol}</p>
              <h2>{formatPrice(market.price, quote)}</h2>
              <p className={market.priceChangePercent >= 0 ? 'positive' : 'negative'}>
                {market.priceChangePercent.toFixed(2)}%
              </p>
            </div>
            <div className="grid">
              <div>
                <p className="muted">High/Low</p>
                <p>
                  {market.highPrice} / {market.lowPrice}
                </p>
              </div>
              <div>
                <p className="muted">Volume</p>
                <p>{market.volume.toLocaleString()}</p>
              </div>
              <div>
                <p className="muted">Updated</p>
                <p>{new Date(market.updatedAt).toLocaleTimeString()}</p>
              </div>
            </div>
          </div>
          <div className="market-card">
            <p className="label">{data?.tradeVenue === 'futures' ? 'Futures balances' : 'Balances'}</p>
            {data?.balances && data.balances.length > 0 ? (
              <div className="balance-list">
                {data.balances.map((balance) => (
                  <BalanceRow key={balance.asset} balance={balance} />
                ))}
              </div>
            ) : (
              <p className="muted">Connect Binance keys to load balances.</p>
            )}
          </div>
        </div>
      )}

      <div className="strategies">
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
              {data.rankedCandidates.slice(0, 10).map((c) => (
                <li key={c.symbol}>
                  {c.symbol}: {c.score.toFixed(2)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
