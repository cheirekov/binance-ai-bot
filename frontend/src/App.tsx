import { useEffect, useMemo, useState } from 'react';

import { executeTrade, fetchStrategy, triggerRefresh } from './api';
import { Balance, StrategyPlan, StrategyResponse } from './types';

const formatUsd = (value: number | undefined) =>
  value === undefined ? '—' : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

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
          {plan.entries[0].side} @ {plan.entries[0].priceTarget.toFixed(2)}
        </p>
        <p className="muted">
          Size {plan.entries[0].size.toFixed(4)} | Confidence {(plan.entries[0].confidence * 100).toFixed(0)}%
        </p>
      </div>
      <div>
        <p className="label">Stops/Targets</p>
        <p className="value">SL {plan.exitPlan.stopLoss.toFixed(2)}</p>
        <p className="muted">
          TP {plan.exitPlan.takeProfit.map((tp) => tp.toFixed(2)).join(' / ')} · {plan.exitPlan.timeframeMinutes}m
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
    <p className="muted">Est. fees {formatUsd(plan.estimatedFees)}</p>
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradeMessage, setTradeMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const payload = await fetchStrategy();
      setData(payload);
      setError(null);
    } catch (err) {
      setError('Unable to reach API. Check docker-compose and ports.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const interval = setInterval(load, 25000);
    return () => clearInterval(interval);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const state = await triggerRefresh();
      setData(state);
    } catch (err) {
      setError('Refresh failed. Try again.');
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
      });
      if (res.simulated) {
        setTradeMessage(res.note ?? 'Simulated trade; enable TRADING_ENABLED to go live.');
      } else {
        setTradeMessage('Order sent to Binance.');
      }
    } catch (err) {
      setTradeMessage('Trade failed. Check logs.');
    }
  };

  const market = data?.market;

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
            <button className="btn ghost" onClick={() => void load()} disabled={loading}>
              Sync status
            </button>
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
          <div className="status-actions">
            <button className="btn soft" onClick={() => simulateTrade('BUY')}>
              Sim buy {tradeQuantity || '—'}
            </button>
            <button className="btn soft" onClick={() => simulateTrade('SELL')}>
              Sim sell {tradeQuantity || '—'}
            </button>
          </div>
        </div>
      </div>

      {market && (
        <div className="market">
          <div className="market-card">
            <div>
              <p className="label">{market.symbol}</p>
              <h2>{formatUsd(market.price)}</h2>
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
            <p className="label">Balances</p>
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
          <p className="muted">Strategy engine warming up...</p>
        )}
      </div>
    </div>
  );
}

export default App;
