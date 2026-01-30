import { useEffect, useMemo, useRef, useState } from 'react';

import { panicLiquidate, setEmergencyStop } from '../api';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { StrategyResponse } from '../types';
import { formatCompactNumber, formatPrice } from '../utils/format';
import { readStorage, writeStorage } from '../utils/storage';
import { formatAgo, formatTime } from '../utils/time';

type HomeEvent = { at: number; text: string };

const PRICE_MOVE_THRESHOLD_PCT = 0.25;
const PRICE_MOVE_ABSURD_PCT = 50;

const isSanePrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12;

const deriveRegime = (data: StrategyResponse | null): 'TREND' | 'RANGE' | 'NEUTRAL' | null => {
  const signals = data?.strategies?.short?.signalsUsed ?? [];
  const hit = signals.find((s) => s.toUpperCase().startsWith('REGIME '));
  if (!hit) return null;
  const parts = hit.toUpperCase().split(' ');
  const regime = parts[1] ?? '';
  if (regime === 'TREND' || regime === 'RANGE' || regime === 'NEUTRAL') return regime;
  return null;
};

const deriveDecision = (data: StrategyResponse | null): { decision: 'HOLD' | 'BUY' | 'SELL'; confidence: number | null } => {
  const ai = data?.aiPolicy?.lastDecision;
  if (ai) {
    const decision = ai.action === 'OPEN' ? 'BUY' : ai.action === 'CLOSE' ? 'SELL' : ai.action === 'PANIC' ? 'SELL' : 'HOLD';
    return { decision, confidence: ai.confidence ?? null };
  }
  const entry = data?.strategies?.short?.entries?.[0];
  if (!entry) return { decision: 'HOLD', confidence: null };
  if (!entry.size || entry.size <= 0) return { decision: 'HOLD', confidence: entry.confidence ?? null };
  return { decision: entry.side === 'SELL' ? 'SELL' : 'BUY', confidence: entry.confidence ?? null };
};

const decisionReasons = (data: StrategyResponse | null): string[] => {
  const aiReason = data?.aiPolicy?.lastDecision?.reason?.trim();
  if (aiReason) {
    const parts = aiReason
      .split(/\n|•|;/g)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.slice(0, 5);
  }
  const plan = data?.strategies?.short;
  const signals = plan?.signalsUsed ?? [];
  const pick = (prefix: string) => signals.find((s) => s.toUpperCase().startsWith(prefix.toUpperCase()));
  const out: string[] = [];
  const regime = pick('Regime');
  if (regime) out.push(regime.replace('Regime', 'Market regime:'));
  const sizeGate = signals.find((s) => s.toUpperCase().startsWith('SIZE GATE:'));
  if (sizeGate) out.push(sizeGate.replace('Size gate:', 'Sizing:'));
  const rsi = pick('RSI14');
  if (rsi) out.push(`Momentum: ${rsi}`);
  const adx = pick('ADX14');
  if (adx) out.push(`Trend strength: ${adx}`);
  const news = pick('News sentiment');
  if (news) out.push(news);
  return out.slice(0, 5);
};

const shortExplainRegime = (regime: string | null) => {
  if (regime === 'TREND') return 'Trend: price is moving directionally; pullbacks can be traded.';
  if (regime === 'RANGE') return 'Range: price is oscillating; mean reversion is favored.';
  if (regime === 'NEUTRAL') return 'Neutral: no clear edge; be conservative.';
  return 'Regime is inferred from indicators (ADX/EMAs).';
};

const countTrackedOrders = (data: StrategyResponse | null) => {
  const grids = Object.values(data?.grids ?? {});
  return grids.reduce((acc, g) => acc + Object.keys(g.ordersByLevel ?? {}).length, 0);
};

export const HomePage = (props: {
  data: StrategyResponse | null;
  loading: boolean;
  error: string | null;
  lastSuccessAt: number | null;
  onRefreshNow: () => Promise<void>;
  onSync: () => Promise<void>;
  onAutoPick: () => Promise<void>;
}) => {
  const toast = useToast();
  const [panicOpen, setPanicOpen] = useState(false);
  const [panicRunning, setPanicRunning] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [events, setEvents] = useState<HomeEvent[]>(() => {
    const raw = readStorage('ui.home.events');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as HomeEvent[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => typeof e?.at === 'number' && typeof e?.text === 'string').slice(0, 50);
    } catch {
      return [];
    }
  });

  const prevRef = useRef<StrategyResponse | null>(null);

  const regime = deriveRegime(props.data);
  const intent = deriveDecision(props.data);
  const reasons = decisionReasons(props.data);
  const market = props.data?.market;
  const quote = market?.quoteAsset ?? props.data?.quoteAsset;

  useEffect(() => {
    const prev = prevRef.current;
    const next = props.data;
    if (!next) return;
    if (!prev) {
      prevRef.current = next;
      return;
    }

    const nextEvents: HomeEvent[] = [];

    const prevSymbol = (prev.symbol ?? '').toUpperCase();
    const nextSymbol = (next.symbol ?? '').toUpperCase();
    const sameSymbol = !!prevSymbol && !!nextSymbol && prevSymbol === nextSymbol;
    const symbolChanged = !!prevSymbol && !!nextSymbol && !sameSymbol;

    if (symbolChanged) {
      nextEvents.push({ at: Date.now(), text: `Active symbol changed: ${prevSymbol} → ${nextSymbol}` });
    }

    if (sameSymbol) {
      // price move (symbol-aware + sanity checks)
      const p0 = prev.market?.price;
      const p1 = next.market?.price;
      if (isSanePrice(p0) && isSanePrice(p1)) {
        const pct = ((p1 - p0) / p0) * 100;
        const absPct = Math.abs(pct);
        if (absPct > PRICE_MOVE_ABSURD_PCT) {
          nextEvents.push({ at: Date.now(), text: `Large price jump (> ${PRICE_MOVE_ABSURD_PCT}% in one tick) — check symbol change / data` });
        } else if (absPct >= PRICE_MOVE_THRESHOLD_PCT) {
          nextEvents.push({ at: Date.now(), text: `Price moved ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` });
        }
      }
    }

    // regime change
    const r0 = deriveRegime(prev);
    const r1 = deriveRegime(next);
    if (r0 && r1 && r0 !== r1) nextEvents.push({ at: Date.now(), text: `Regime changed: ${r0} → ${r1}` });

    // decision change
    const d0 = deriveDecision(prev).decision;
    const d1 = deriveDecision(next).decision;
    if (d0 !== d1) nextEvents.push({ at: Date.now(), text: `Intent changed: ${d0} → ${d1}` });

    // order tracking change (bot)
    const o0 = countTrackedOrders(prev);
    const o1 = countTrackedOrders(next);
    if (o0 !== o1) nextEvents.push({ at: Date.now(), text: `Tracked grid orders: ${o0} → ${o1}` });

    // risk flags
    const f0 = (prev.riskFlags ?? []).join('|');
    const f1 = (next.riskFlags ?? []).join('|');
    if (f0 !== f1) nextEvents.push({ at: Date.now(), text: `Risk flags changed` });

    // halt / stop
    if (!!prev.emergencyStop !== !!next.emergencyStop) nextEvents.push({ at: Date.now(), text: `Emergency stop ${next.emergencyStop ? 'enabled' : 'cleared'}` });
    if (!!prev.tradeHalted !== !!next.tradeHalted) nextEvents.push({ at: Date.now(), text: `Trade halt ${next.tradeHalted ? 'enabled' : 'cleared'}` });

    if (nextEvents.length) {
      setEvents((prevEvents) => {
        const merged = [...nextEvents, ...prevEvents].slice(0, 50);
        writeStorage('ui.home.events', JSON.stringify(merged));
        return merged;
      });
    }

    prevRef.current = next;
  }, [props.data]);

  const onToggleEmergencyStop = async () => {
    const enabled = !(props.data?.emergencyStop ?? false);
    try {
      await setEmergencyStop(enabled, enabled ? 'ui-home' : 'ui-home-clear');
      toast.success(enabled ? 'Emergency stop enabled.' : 'Emergency stop cleared.');
      await props.onSync();
    } catch {
      toast.error('Failed to toggle emergency stop.');
    }
  };

  const onPanic = async () => {
    setPanicRunning(true);
    try {
      const res = await panicLiquidate({ stopAutoTrade: true });
      toast.warning(`Panic complete: placed ${res.summary.placed}, skipped ${res.summary.skipped}, errors ${res.summary.errored}.`);
      setPanicOpen(false);
      await props.onSync();
    } catch {
      toast.error('Panic failed. Check API logs.');
    } finally {
      setPanicRunning(false);
    }
  };

  const protection = useMemo(() => {
    const positions = Object.values(props.data?.positions ?? {});
    const ocoArmed = positions.filter((p) => typeof p.ocoOrderListId === 'number').length;
    const riskFlags = props.data?.riskFlags?.length ?? 0;
    return { ocoArmed, riskFlags };
  }, [props.data?.positions, props.data?.riskFlags?.length]);

  return (
    <div className="page">
      <div className="grid grid-2">
        <Card
          eyebrow="Market"
          title={market?.symbol ?? props.data?.symbol ?? '—'}
          right={
            market ? (
              <Chip tone={market.priceChangePercent >= 0 ? 'good' : 'bad'}>{market.priceChangePercent.toFixed(2)}%</Chip>
            ) : null
          }
          subtitle={market?.updatedAt ? `Updated ${formatAgo(market.updatedAt)}` : '—'}
        >
          {market ? (
            <div className="kv-grid">
              <div className="kv">
                <div className="label">Price</div>
                <div className="value">{formatPrice(market.price, quote, 10)}</div>
              </div>
              <div className="kv">
                <div className="label">24h High/Low</div>
                <div className="value">
                  {formatCompactNumber(market.highPrice, { maxDecimals: 10 })} / {formatCompactNumber(market.lowPrice, { maxDecimals: 10 })}
                </div>
              </div>
              <div className="kv">
                <div className="label">Volume</div>
                <div className="value">{formatCompactNumber(market.volume, { maxDecimals: 2 })}</div>
              </div>
              <div className="kv">
                <div className="label">
                  Regime{' '}
                  <span className="help" title={shortExplainRegime(regime)}>
                    ?
                  </span>
                </div>
                <div className="value">{regime ?? '—'}</div>
              </div>
            </div>
          ) : (
            <p className="muted">No market snapshot yet. Use “Refresh now”.</p>
          )}
        </Card>

        <Card eyebrow="Bot intent" title={props.data?.aiPolicyMode && props.data.aiPolicyMode !== 'off' ? 'AI policy' : 'Strategy'}>
          <div className="intent">
            <div className={`intent-decision intent-${intent.decision.toLowerCase()}`}>{intent.decision}</div>
            <div className="muted">
              Confidence: {intent.confidence !== null ? `${Math.round(intent.confidence * 100)}%` : '—'} · Updated {props.lastSuccessAt ? formatAgo(props.lastSuccessAt) : '—'}
            </div>
          </div>
          {reasons.length ? (
            <ul className="bullets">
              {reasons.slice(0, 5).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No rationale available yet.</p>
          )}
          <div className="divider" />
          <div className="kv-row">
            <div className="kv">
              <div className="label">Protection</div>
              <div className="value">{protection.ocoArmed ? `OCO armed (${protection.ocoArmed})` : 'OCO not detected'}</div>
              <div className="muted">Cooldown and daily loss caps are enforced by the backend.</div>
            </div>
            <div className="kv">
              <div className="label">Risk flags</div>
              <div className="value">{protection.riskFlags ? protection.riskFlags : 'None'}</div>
              {props.data?.tradeHalted ? <div className="muted">Trading is halted due to risk flags.</div> : null}
            </div>
          </div>
        </Card>

        <Card
          eyebrow="What changed"
          title="Since last tick"
          right={
            events.length ? (
              <button className="btn ghost small" onClick={() => setEventsOpen(true)} type="button">
                View all
              </button>
            ) : null
          }
          subtitle={events.length ? `${events.length} events kept` : 'No changes yet'}
        >
          {events.length ? (
            <div className="event-list">
              {events.slice(0, 8).map((e) => (
                <div key={`${e.at}:${e.text}`} className="event">
                  <span className="muted mono">{formatTime(e.at)}</span>
                  <span>{e.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">We’ll summarize meaningful changes (price, intent, safety flags) after the next update.</p>
          )}
        </Card>

        <Card eyebrow="Quick actions" title="Safe by default" subtitle={props.error ? `Last error: ${props.error}` : props.loading ? 'Loading…' : 'Ready'}>
          <div className="actions">
            <button className="btn primary" onClick={() => void props.onRefreshNow()} disabled={props.loading} type="button">
              Refresh now
            </button>
            <button className="btn soft" onClick={() => void props.onSync()} disabled={props.loading} type="button">
              Sync status
            </button>
            <button className="btn soft" onClick={() => void props.onAutoPick()} disabled={props.loading} type="button">
              Auto-pick best
            </button>
            {props.data?.autoTradeEnabled ? (
              <button className="btn ghost" onClick={() => void onToggleEmergencyStop()} disabled={props.loading} type="button" title="Pauses/resumes auto-trade via emergency stop">
                {props.data?.emergencyStop ? 'Resume auto-trade' : 'Pause auto-trade'}
              </button>
            ) : null}
          </div>

          <details className="details">
            <summary>Danger zone</summary>
            <p className="muted">
              Dangerous actions are intentionally separated and always require confirmation. If LIVE trading is enabled, these affect real funds.
            </p>
            <div className="actions">
              <button className="btn danger" onClick={() => setPanicOpen(true)} disabled={panicRunning} type="button">
                PANIC / FLATTEN
              </button>
            </div>
          </details>
        </Card>
      </div>

      <Modal
        open={eventsOpen}
        title="Change log (last 50)"
        onClose={() => setEventsOpen(false)}
        actions={
          <button className="btn soft" onClick={() => setEventsOpen(false)} type="button">
            Close
          </button>
        }
      >
        {events.length ? (
          <div className="event-list">
            {events.map((e) => (
              <div key={`${e.at}:${e.text}`} className="event">
                <span className="muted mono">{formatTime(e.at)}</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No events yet.</p>
        )}
      </Modal>

      <Modal
        open={panicOpen}
        danger
        title="Panic / Flatten"
        onClose={() => (panicRunning ? null : setPanicOpen(false))}
        actions={
          <>
            <button className="btn ghost" onClick={() => setPanicOpen(false)} disabled={panicRunning} type="button">
              Cancel
            </button>
            <button className="btn danger" onClick={() => void onPanic()} disabled={panicRunning} type="button">
              {panicRunning ? 'Running…' : 'Confirm panic'}
            </button>
          </>
        }
      >
        <p className="muted">
          {props.data?.tradeVenue === 'futures'
            ? 'This will MARKET-close all open futures positions (reduce-only) and enable Emergency Stop to prevent re-entry.'
            : `This will MARKET-sell free spot balances into ${props.data?.homeAsset ?? 'HOME'} where a direct market exists, and enable Emergency Stop to prevent re-entry.`}
        </p>
        <p className="muted">Make sure you understand the consequences before proceeding.</p>
      </Modal>
    </div>
  );
};
