import { useEffect, useMemo, useState } from 'react';

import { fetchPerformanceStatsOptional } from '../api';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { PerformanceStatsResponse, StrategyResponse } from '../types';
import { formatCompactNumber, formatPrice } from '../utils/format';
import { formatAgo } from '../utils/time';

type BalanceRow = { asset: string; free: number; locked: number };

const getBalance = (balances: BalanceRow[], asset?: string | null) => {
  if (!asset) return null;
  const upper = asset.toUpperCase();
  return balances.find((b) => b.asset.toUpperCase() === upper) ?? null;
};

const estimatePositionPnl = (p: { side: 'BUY' | 'SELL'; entryPrice: number; size: number }, price?: number | null) => {
  if (!price || !Number.isFinite(price)) return null;
  if (!Number.isFinite(p.entryPrice) || !Number.isFinite(p.size)) return null;
  const diff = (price - p.entryPrice) * p.size;
  return p.side === 'SELL' ? -diff : diff;
};

export const PortfolioPage = (props: { data: StrategyResponse | null; loading: boolean }) => {
  const [showAllBalances, setShowAllBalances] = useState(false);
  const [perf, setPerf] = useState<PerformanceStatsResponse | null>(null);
  const [showAllDays, setShowAllDays] = useState(false);
  const data = props.data;
  const balances = useMemo(() => (data?.balances ?? []).map((b) => ({ asset: b.asset.toUpperCase(), free: b.free ?? 0, locked: b.locked ?? 0 })), [data?.balances]);
  const homeAsset = data?.homeAsset?.toUpperCase() ?? null;
  const quoteAsset = (data?.market?.quoteAsset ?? data?.quoteAsset)?.toUpperCase() ?? null;
  const homeBal = getBalance(balances, homeAsset);
  const quoteBal = getBalance(balances, quoteAsset);
  const marketPrice = data?.market?.price ?? null;
  const marketSymbol = data?.market?.symbol?.toUpperCase() ?? null;

  const positions = useMemo(() => {
    const rows = Object.entries(data?.positions ?? {}).map(([key, p]) => ({ key, ...p }));
    return rows.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  }, [data?.positions]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchPerformanceStatsOptional();
      if (cancelled) return;
      setPerf(res);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const topBalances = useMemo(() => {
    const filtered = balances
      .map((b) => ({ ...b, total: b.free + b.locked }))
      .filter((b) => b.total > 0)
      .sort((a, b) => b.locked - a.locked || b.total - a.total || a.asset.localeCompare(b.asset));

    const keep = new Map<string, BalanceRow>();
    if (homeAsset) {
      const hb = getBalance(balances, homeAsset);
      if (hb) keep.set(homeAsset, hb);
    }
    if (quoteAsset) {
      const qb = getBalance(balances, quoteAsset);
      if (qb) keep.set(quoteAsset, qb);
    }
    for (const b of filtered) {
      if (keep.size >= 5) break;
      keep.set(b.asset, b);
    }
    return Array.from(keep.values());
  }, [balances, homeAsset, quoteAsset]);

  return (
    <div className="page">
      <div className="grid grid-2">
        <Card eyebrow="Equity" title="Summary" subtitle={data?.equity?.lastAt ? `Updated ${formatAgo(data.equity.lastAt)}` : '—'}>
          {data?.equity ? (
            <div className="kv-grid">
              <div className="kv">
                <div className="label">Total equity (est.)</div>
                <div className="value">
                  {data.equity.lastHome.toLocaleString(undefined, { maximumFractionDigits: 2 })} {data.equity.homeAsset}
                </div>
              </div>
              <div className="kv">
                <div className="label">PnL</div>
                <div className={data.equity.pnlHome >= 0 ? 'value positive' : 'value negative'}>
                  {(data.equity.pnlHome >= 0 ? '+' : '') + data.equity.pnlHome.toLocaleString(undefined, { maximumFractionDigits: 2 })} ({(data.equity.pnlPct >= 0 ? '+' : '') + data.equity.pnlPct.toFixed(2)}%)
                </div>
                <div className="muted">Since {new Date(data.equity.startAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div className="kv">
                <div className="label">{homeAsset ?? 'Home'} free/locked</div>
                <div className="value">
                  {formatCompactNumber(homeBal?.free ?? 0)} / {formatCompactNumber(homeBal?.locked ?? 0)}
                </div>
              </div>
              {quoteAsset && quoteAsset !== homeAsset ? (
                <div className="kv">
                  <div className="label">{quoteAsset} free/locked</div>
                  <div className="value">
                    {formatCompactNumber(quoteBal?.free ?? 0)} / {formatCompactNumber(quoteBal?.locked ?? 0)}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted">Equity estimate is unavailable. Enable portfolio mode and SQLite for richer stats.</p>
          )}
          {data?.equity?.missingAssets?.length ? <p className="muted">Unpriced assets: {data.equity.missingAssets.join(', ')}</p> : null}
        </Card>

        <Card eyebrow="Positions" title={positions.length ? `${positions.length} open` : 'None'} subtitle={data?.portfolioEnabled ? 'Portfolio mode: ON' : 'Portfolio mode: OFF (showing tracked positions)'}>
          {positions.length ? (
            <div className="stack">
              {positions.map((p) => {
                const canEstimate = marketSymbol && p.symbol.toUpperCase() === marketSymbol;
                const pnl = canEstimate ? estimatePositionPnl({ side: p.side, entryPrice: p.entryPrice, size: p.size }, marketPrice) : null;
                const pnlLabel = pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${formatCompactNumber(pnl, { maxDecimals: 2 })} ${quoteAsset ?? ''}`.trim();
                return (
                  <details key={p.key} className="position-card">
                    <summary>
                      <div className="position-head">
                        <div className="position-symbol">{p.symbol}</div>
                        <div className="position-meta">
                          <Chip tone={p.side === 'BUY' ? 'good' : 'warn'}>{p.side === 'BUY' ? 'LONG' : 'SHORT'}</Chip>
                          <span className="muted">{p.horizon}</span>
                        </div>
                      </div>
                      <div className="position-sub">
                        <span className="muted">
                          Avg {formatPrice(p.entryPrice, quoteAsset ?? undefined, 8)} · Qty {formatCompactNumber(p.size, { maxDecimals: 8 })}
                        </span>
                        <span
                          className={pnl !== null && pnl >= 0 ? 'mono positive' : pnl !== null ? 'mono negative' : 'mono'}
                          title={canEstimate ? 'Estimated from current market price' : 'Switch symbol to estimate unrealized PnL'}
                        >
                          {pnlLabel}
                        </span>
                      </div>
                    </summary>
                    <div className="kv-grid">
                      <div className="kv">
                        <div className="label">Stop loss</div>
                        <div className="value">{p.stopLoss ? formatPrice(p.stopLoss, quoteAsset ?? undefined, 8) : '—'}</div>
                      </div>
                      <div className="kv">
                        <div className="label">Take profit</div>
                        <div className="value">{p.takeProfit?.length ? p.takeProfit.map((tp) => formatPrice(tp, quoteAsset ?? undefined, 8)).join(' / ') : '—'}</div>
                      </div>
                      <div className="kv">
                        <div className="label">Protection</div>
                        <div className="value">{typeof p.ocoOrderListId === 'number' ? `OCO armed (#${p.ocoOrderListId})` : '—'}</div>
                      </div>
                      <div className="kv">
                        <div className="label">Opened</div>
                        <div className="value">{new Date(p.openedAt).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          ) : (
            <p className="muted">No open positions right now.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        {perf ? (
          <Card
            eyebrow="Performance"
            title={perf.enabled ? 'Stats (SQLite)' : 'Stats (disabled)'}
            right={
              perf.netPnlByDay.length ? (
                <button className="btn ghost small" onClick={() => setShowAllDays((v) => !v)} type="button">
                  {showAllDays ? 'Last 7 days' : 'Show all days'}
                </button>
              ) : null
            }
            subtitle={perf.enabled ? 'Read-only summary of closed trades.' : 'Enable SQLite persistence to track trades/fees over time.'}
          >
            <div className="kv-grid">
              <div className="kv">
                <div className="label">Total trades</div>
                <div className="value">{perf.totalTrades}</div>
              </div>
              <div className="kv">
                <div className="label">Win rate</div>
                <div className="value">{perf.winRate === null ? '—' : `${(perf.winRate * 100).toFixed(1)}%`}</div>
              </div>
              <div className="kv">
                <div className="label">Total fees</div>
                <div className="value">{formatCompactNumber(perf.totalFees, { maxDecimals: 2 })}</div>
              </div>
              <div className="kv">
                <div className="label">Max drawdown</div>
                <div className="value">{perf.maxDrawdown === null ? '—' : formatCompactNumber(perf.maxDrawdown, { maxDecimals: 2 })}</div>
              </div>
              <div className="kv">
                <div className="label">Avg win</div>
                <div className="value">{perf.avgWin === null ? '—' : formatCompactNumber(perf.avgWin, { maxDecimals: 2 })}</div>
              </div>
              <div className="kv">
                <div className="label">Avg loss</div>
                <div className="value">{perf.avgLoss === null ? '—' : formatCompactNumber(perf.avgLoss, { maxDecimals: 2 })}</div>
              </div>
            </div>

            {perf.netPnlByDay.length ? (
              <>
                <div className="divider" />
                <div className="label">PnL by day</div>
                <div className="stack">
                  {(showAllDays ? perf.netPnlByDay : perf.netPnlByDay.slice(-7)).map((d) => (
                    <div key={d.day} className="candidate-row">
                      <span className="mono">{d.day}</span>
                      <span className={d.netPnlHome >= 0 ? 'mono positive' : 'mono negative'}>
                        {(d.netPnlHome >= 0 ? '+' : '') + formatCompactNumber(d.netPnlHome, { maxDecimals: 2 })}
                        <span className="muted"> · fees {formatCompactNumber(d.feesHome, { maxDecimals: 2 })}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">No trade history yet.</p>
            )}
          </Card>
        ) : null}

        <Card
          eyebrow="Balances"
          title={showAllBalances ? 'All assets' : 'Top assets'}
          right={
            balances.length ? (
              <button className="btn ghost small" onClick={() => setShowAllBalances((v) => !v)} type="button">
                {showAllBalances ? 'Show top' : 'Show all'}
              </button>
            ) : null
          }
          subtitle="Free = available. Locked = reserved in open orders."
        >
          {balances.length ? (
            <div className="balance-list">
              {(showAllBalances ? balances : topBalances).map((b) => (
                <div key={b.asset} className="balance-row">
                  <div className="mono">{b.asset}</div>
                  <div className="muted">
                    Total {formatCompactNumber(b.free + b.locked)} · Free {formatCompactNumber(b.free)} · Locked {formatCompactNumber(b.locked)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No balances to show.</p>
          )}
        </Card>

        <Card eyebrow="Notes" title="What do I do now?">
          <ul className="bullets">
            <li>Start on Home: check LIVE vs SIM, venue, and any halt banners.</li>
            <li>If risk flags appear, go to Status and resolve before enabling LIVE trading.</li>
            <li>Use Strategy for explainable signals; use Orders to monitor fills and open orders.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
};
