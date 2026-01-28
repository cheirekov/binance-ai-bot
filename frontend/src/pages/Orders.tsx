import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchOpenOrders, fetchOrderHistory } from '../api';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { useToast } from '../components/ui/Toast';
import { OrderRow, StrategyResponse } from '../types';
import { formatCompactNumber, formatOrderType, formatPrice } from '../utils/format';
import { formatDateTimeShort } from '../utils/time';

type OrdersView = 'open' | 'recent' | 'tracked';

const orderTone = (o: OrderRow) => {
  const side = (o.side ?? '').toUpperCase();
  if (side === 'BUY') return 'good';
  if (side === 'SELL') return 'warn';
  return 'neutral';
};

export const OrdersPage = (props: { data: StrategyResponse | null; selectedSymbol: string }) => {
  const toast = useToast();
  const [view, setView] = useState<OrdersView>('open');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openOrders, setOpenOrders] = useState<OrderRow[]>([]);
  const [recentOrders, setRecentOrders] = useState<OrderRow[]>([]);

  const quoteAsset = (props.data?.market?.quoteAsset ?? props.data?.quoteAsset)?.toUpperCase();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === 'recent') {
        const sym = props.selectedSymbol.toUpperCase();
        const res = await fetchOrderHistory({ symbol: sym, limit: 80 });
        if (!res.ok) throw new Error('Failed to load order history');
        setRecentOrders(res.orders ?? []);
      } else {
        const res =
          view === 'tracked'
            ? await fetchOpenOrders()
            : await fetchOpenOrders({ symbol: props.selectedSymbol.toUpperCase() });
        if (!res.ok) throw new Error('Failed to load open orders');
        setOpenOrders(res.openOrders ?? []);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load orders';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [props.selectedSymbol, toast, view]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), view === 'recent' ? 35_000 : 20_000);
    return () => window.clearInterval(interval);
  }, [load, view]);

  const rows = view === 'recent' ? recentOrders : openOrders;

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const st = statusFilter.trim().toUpperCase();
    return rows.filter((o) => {
      if (q && !o.symbol.toUpperCase().includes(q)) return false;
      if (st && (o.status ?? '').toUpperCase() !== st) return false;
      return true;
    });
  }, [query, rows, statusFilter]);

  const uniqueStatuses = useMemo(() => {
    const set = new Set(rows.map((o) => (o.status ?? '').toUpperCase()).filter(Boolean));
    return Array.from(set).sort();
  }, [rows]);

  const mobileCards = (
    <div className="stack">
      {filtered.map((o) => (
        <div key={`${o.orderId}:${o.symbol}`} className="order-card">
          <div className="order-top">
            <div className="mono">{o.symbol}</div>
            <Chip tone={orderTone(o)}>{(o.side ?? '—').toUpperCase()}</Chip>
          </div>
          <div className="order-mid">
            <div className="muted">
              {formatOrderType(o.type)} · {o.status}
            </div>
            <div className="mono">{formatDateTimeShort(o.updateTime ?? o.time)}</div>
          </div>
          <div className="order-grid">
            <div>
              <div className="label">Price</div>
              <div className="value">{formatPrice(o.price, quoteAsset, 10)}</div>
            </div>
            <div>
              <div className="label">Qty</div>
              <div className="value">{formatCompactNumber(o.origQty, { maxDecimals: 8 })}</div>
            </div>
            <div>
              <div className="label">Filled</div>
              <div className="value">{formatCompactNumber(o.executedQty, { maxDecimals: 8 })}</div>
            </div>
          </div>
          {o.bot ? (
            <div className="muted">
              Source: {o.bot.source}
              {o.bot.gridSymbol ? ` · grid ${o.bot.gridSymbol}` : ''}
              {o.bot.positionKey ? ` · pos ${o.bot.positionKey}` : ''}
            </div>
          ) : null}
        </div>
      ))}
      {!filtered.length ? <p className="muted">No orders match your filters.</p> : null}
    </div>
  );

  const desktopTable = (
    <div className="table">
      <div className="tr th tr-orders">
        <div>Symbol</div>
        <div>Order</div>
        <div>Side</div>
        <div>Type</div>
        <div>Status</div>
        <div className="right">Price</div>
        <div className="right">Qty</div>
        <div className="right">Filled</div>
      </div>
      {filtered.map((o) => (
        <div key={`${o.orderId}:${o.symbol}`} className="tr tr-orders">
          <div className="mono">{o.symbol}</div>
          <div className="mono">#{o.orderId}</div>
          <div>
            <Chip tone={orderTone(o)}>{(o.side ?? '—').toUpperCase()}</Chip>
          </div>
          <div>{formatOrderType(o.type)}</div>
          <div>{o.status}</div>
          <div className="right mono">{formatCompactNumber(o.price, { maxDecimals: 10 })}</div>
          <div className="right mono">{formatCompactNumber(o.origQty, { maxDecimals: 8 })}</div>
          <div className="right mono">{formatCompactNumber(o.executedQty, { maxDecimals: 8 })}</div>
        </div>
      ))}
      {!filtered.length ? <p className="muted">No orders.</p> : null}
    </div>
  );

  return (
    <div className="page">
      <Card eyebrow="Orders" title="Monitor execution" subtitle="Use filters to find what matters. Cancel actions are intentionally restricted for safety.">
        <div className="orders-controls">
          <SegmentedControl
            value={view}
            onChange={setView}
            ariaLabel="Order view"
            options={[
              { value: 'open', label: 'Open' },
              { value: 'recent', label: 'Recent' },
              { value: 'tracked', label: 'Tracked', badge: props.data?.positions ? Object.keys(props.data.positions).length : undefined },
            ]}
          />
          <div className="actions">
            <input className="input" placeholder="Search symbol… (e.g. BTC)" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="select small" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {uniqueStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button className="btn ghost" onClick={() => void load()} disabled={loading} type="button">
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </Card>

      <div className="orders-responsive">
        <div className="mobile-only">{mobileCards}</div>
        <div className="desktop-only">{desktopTable}</div>
      </div>
    </div>
  );
};

