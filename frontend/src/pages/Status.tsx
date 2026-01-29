import { useEffect, useMemo, useRef, useState } from 'react';

import { executeTrade, fetchDbStatsOptional, panicLiquidate, setEmergencyStop, sweepUnused } from '../api';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { DbStatsResponse, StrategyResponse } from '../types';
import { formatCompactNumber } from '../utils/format';
import { readStorage, removeStorage, writeStorage } from '../utils/storage';
import { formatAgo, formatDateTimeShort } from '../utils/time';

const ADVANCED_KEY = 'ui.advancedMode';
const ADVANCED_LAST_ACTIVE_KEY = 'ui.advancedMode.lastActiveAt';
const ADVANCED_TTL_MS = 10 * 60_000;

const normalizeTypedConfirm = (v: string) => v.trim().replace(/\s+/g, ' ').toUpperCase();

export const StatusPage = (props: { data: StrategyResponse | null; selectedSymbol: string; onSync: () => Promise<void> }) => {
  const toast = useToast();
  const [dangerOpen, setDangerOpen] = useState<null | 'panic' | 'sweep'>(null);
  const [dangerRunning, setDangerRunning] = useState(false);

  const [dbHealth, setDbHealth] = useState<DbStatsResponse | null>(null);

  const [advancedMode, setAdvancedMode] = useState(() => (readStorage(ADVANCED_KEY) ?? 'false') === 'true');
  const [typed, setTyped] = useState('');
  const [manualSide, setManualSide] = useState<null | 'BUY' | 'SELL'>(null);
  const [manualRunning, setManualRunning] = useState(false);

  const initialLastActiveAt = (() => {
    const raw = readStorage(ADVANCED_LAST_ACTIVE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : Date.now();
  })();

  const lastActiveRef = useRef<number>(initialLastActiveAt);

  const tickAdvancedExpiry = () => {
    if (!advancedMode) return;
    const now = Date.now();
    const last = lastActiveRef.current;
    if (now - last >= ADVANCED_TTL_MS) {
      setAdvancedMode(false);
      writeStorage(ADVANCED_KEY, 'false');
      removeStorage(ADVANCED_LAST_ACTIVE_KEY);
      toast.info('Advanced mode auto-disabled after inactivity.');
    }
  };

  useEffect(() => {
    if (!advancedMode) return;
    const onActivity = () => {
      lastActiveRef.current = Date.now();
      writeStorage(ADVANCED_LAST_ACTIVE_KEY, String(lastActiveRef.current));
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'mousemove', 'scroll', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    const interval = window.setInterval(tickAdvancedExpiry, 15_000);
    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advancedMode]);

  useEffect(() => {
    writeStorage(ADVANCED_KEY, String(advancedMode));
    if (advancedMode) {
      lastActiveRef.current = Date.now();
      writeStorage(ADVANCED_LAST_ACTIVE_KEY, String(lastActiveRef.current));
    } else {
      removeStorage(ADVANCED_LAST_ACTIVE_KEY);
      setManualSide(null);
      setTyped('');
    }
  }, [advancedMode]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetchDbStatsOptional();
      if (cancelled) return;
      setDbHealth(res);
    };
    void load();
    const interval = window.setInterval(() => void load(), 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const tradingEnabled = !!props.data?.tradingEnabled;
  const autoTradeEnabled = !!props.data?.autoTradeEnabled;
  const emergencyStop = !!props.data?.emergencyStop;
  const tradeHalted = !!props.data?.tradeHalted;
  const venue = props.data?.tradeVenue ?? 'spot';
  const quoteAsset = (props.data?.market?.quoteAsset ?? props.data?.quoteAsset)?.toUpperCase() ?? '';

  const expectedTyped = useMemo(() => {
    if (!manualSide) return null;
    return `LIVE ${manualSide} ${props.selectedSymbol.toUpperCase()}`;
  }, [manualSide, props.selectedSymbol]);

  const typedOk = useMemo(() => {
    if (!tradingEnabled) return true;
    if (!expectedTyped) return false;
    return normalizeTypedConfirm(typed) === expectedTyped;
  }, [expectedTyped, tradingEnabled, typed]);

  const onToggleEmergencyStop = async () => {
    const enabled = !emergencyStop;
    try {
      await setEmergencyStop(enabled, enabled ? 'ui-status' : 'ui-status-clear');
      toast.success(enabled ? 'Emergency stop enabled.' : 'Emergency stop cleared.');
      await props.onSync();
    } catch {
      toast.error('Failed to toggle emergency stop.');
    }
  };

  const onDangerAction = async () => {
    if (!dangerOpen) return;
    setDangerRunning(true);
    try {
      if (dangerOpen === 'panic') {
        const res = await panicLiquidate({ stopAutoTrade: true });
        toast.warning(`Panic complete: placed ${res.summary.placed}, skipped ${res.summary.skipped}, errors ${res.summary.errored}.`);
      }
      if (dangerOpen === 'sweep') {
        const res = await sweepUnused({ keepAllowedQuotes: true, keepPositionAssets: true, stopAutoTrade: false });
        toast.success(`Sweep complete: placed ${res.summary.placed}, skipped ${res.summary.skipped}, errors ${res.summary.errored}.`);
      }
      setDangerOpen(null);
      await props.onSync();
    } catch {
      toast.error('Action failed. Check API logs.');
    } finally {
      setDangerRunning(false);
    }
  };

  const onManualTrade = async () => {
    if (!manualSide) return;
    setManualRunning(true);
    try {
      const qty = props.data?.strategies?.short?.entries?.[0]?.size ?? 0.001;
      const res = await executeTrade({ side: manualSide, quantity: qty, type: 'MARKET', symbol: props.selectedSymbol.toUpperCase() });
      if (res?.riskFlags?.length) toast.error(`Trade halted: ${res.riskFlags.join('; ')}`);
      else if (res?.simulated) toast.info(res.note ?? 'Simulated trade.');
      else toast.success('Order sent to Binance.');
      setManualSide(null);
      setTyped('');
      await props.onSync();
    } catch {
      toast.error('Trade failed. Check API logs.');
    } finally {
      setManualRunning(false);
    }
  };

  const systemStatus = props.data?.error ? 'Error' : props.data?.status ?? '—';
  const riskFlags = props.data?.riskFlags ?? [];

  return (
    <div className="page">
      <div className="grid grid-2">
        <Card eyebrow="System" title="Health" subtitle={props.data?.lastUpdated ? `Last tick ${formatAgo(props.data.lastUpdated)}` : '—'}>
          <div className="kv-grid">
            <div className="kv">
              <div className="label">Status</div>
              <div className={props.data?.error ? 'value negative' : 'value'}>{systemStatus}</div>
              {props.data?.error ? <div className="muted">{props.data.error.slice(0, 160)}</div> : null}
            </div>
            <div className="kv">
              <div className="label">Venue</div>
              <div className="value">{venue}</div>
            </div>
            <div className="kv">
              <div className="label">Last auto-trade</div>
              <div className="value">{props.data?.lastAutoTrade ? `${props.data.lastAutoTrade.action}` : '—'}</div>
              <div className="muted">{props.data?.lastAutoTrade?.at ? formatDateTimeShort(props.data.lastAutoTrade.at) : ''}</div>
            </div>
            <div className="kv">
              <div className="label">Active symbol</div>
              <div className="value">{props.data?.activeSymbol ?? '—'}</div>
              <div className="muted">{props.data?.autoSelectUpdatedAt ? `Picked ${formatAgo(props.data.autoSelectUpdatedAt)}` : ''}</div>
            </div>
          </div>
        </Card>

        <Card eyebrow="Modes" title="Safety first">
          <div className="chip-row">
            <Chip tone={tradingEnabled ? 'danger' : 'good'} title={tradingEnabled ? 'Real orders can be placed' : 'Orders are simulated unless trading is enabled'}>
              {tradingEnabled ? 'LIVE' : 'SIM'}
            </Chip>
            <Chip tone={autoTradeEnabled ? (emergencyStop ? 'warn' : 'good') : 'neutral'}>Auto-trade: {autoTradeEnabled ? (emergencyStop ? 'Paused' : 'On') : 'Off'}</Chip>
            <Chip tone={tradeHalted ? 'warn' : 'neutral'}>Halted: {tradeHalted ? 'Yes' : 'No'}</Chip>
            <Chip tone={emergencyStop ? 'warn' : 'neutral'}>E‑Stop: {emergencyStop ? 'On' : 'Off'}</Chip>
            <Chip tone={props.data?.gridEnabled ? 'good' : 'neutral'}>Grid: {props.data?.gridEnabled ? 'On' : 'Off'}</Chip>
            <Chip tone={props.data?.portfolioEnabled ? 'good' : 'neutral'}>Portfolio: {props.data?.portfolioEnabled ? 'On' : 'Off'}</Chip>
            <Chip tone={props.data?.conversionEnabled ? 'good' : 'neutral'}>Convert: {props.data?.conversionEnabled ? 'On' : 'Off'}</Chip>
            <Chip tone={props.data?.aiPolicyMode && props.data.aiPolicyMode !== 'off' ? 'good' : 'neutral'}>AI: {props.data?.aiPolicyMode ?? 'off'}</Chip>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => void onToggleEmergencyStop()} type="button">
              {emergencyStop ? 'Clear emergency stop' : 'Enable emergency stop'}
            </button>
            <button className="btn soft" onClick={() => void props.onSync()} type="button">
              Sync now
            </button>
          </div>
          {riskFlags.length ? (
            <div className="risk">
              <div className="label">Risk flags</div>
              <ul>
                {riskFlags.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">No risk flags reported.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card eyebrow="Risk & limits" title="What constrains the bot">
          <div className="kv-grid">
            <div className="kv">
              <div className="label">Max position size</div>
              <div className="value">{props.data?.risk?.maxPositionSizeUsdt ? `${formatCompactNumber(props.data.risk.maxPositionSizeUsdt, { maxDecimals: 2 })} USDT` : '—'}</div>
            </div>
            <div className="kv">
              <div className="label">Risk per trade</div>
              <div className="value">{props.data?.risk?.riskPerTradeFraction ? `${(props.data.risk.riskPerTradeFraction * 100).toFixed(2)}%` : '—'}</div>
            </div>
            <div className="kv">
              <div className="label">Fee rate (maker/taker)</div>
              <div className="value">{props.data?.risk?.feeRate ? `${(props.data.risk.feeRate.maker * 100).toFixed(2)}% / ${(props.data.risk.feeRate.taker * 100).toFixed(2)}%` : '—'}</div>
            </div>
            <div className="kv">
              <div className="label">Cooldown</div>
              <div className="value">Backend-managed</div>
              <div className="muted">{props.data?.lastAutoTrade?.at ? `Last attempt ${formatAgo(props.data.lastAutoTrade.at)}` : ''}</div>
            </div>
          </div>
          <p className="muted">Some limits (daily loss cap, max positions) are enforced by the backend and may not be fully reported to the UI.</p>
        </Card>

        <Card eyebrow="Danger zone" title="High impact actions" subtitle="Collapsed by default; always confirm">
          <details className="details">
            <summary>Open danger zone</summary>
            <p className="muted">Manual intervention should be rare. These actions can affect real funds when LIVE is enabled.</p>
            <div className="actions">
              <button className="btn danger" onClick={() => setDangerOpen('panic')} type="button">
                Panic / Flatten
              </button>
              {venue === 'spot' ? (
                <button className="btn soft" onClick={() => setDangerOpen('sweep')} type="button">
                  Sweep unused
                </button>
              ) : null}
            </div>
          </details>
        </Card>

        {dbHealth ? (
          <Card
            eyebrow="DB health"
            title="SQLite"
            subtitle={dbHealth.sqliteFile ? `File: ${dbHealth.sqliteFile}` : '—'}
          >
            <div className="kv-grid">
              <div className="kv">
                <div className="label">Status</div>
                <div className="value">Enabled</div>
                <div className="muted">{dbHealth.lastWriteAt ? `Last write ${formatAgo(dbHealth.lastWriteAt)}` : 'No writes yet'}</div>
              </div>
              <div className="kv">
                <div className="label">market_features</div>
                <div className="value">{dbHealth.counts.market_features}</div>
              </div>
              <div className="kv">
                <div className="label">decisions</div>
                <div className="value">{dbHealth.counts.decisions}</div>
              </div>
              <div className="kv">
                <div className="label">trades</div>
                <div className="value">{dbHealth.counts.trades}</div>
              </div>
            </div>
            {dbHealth.lastError ? <p className="muted">Last error: {dbHealth.lastError}</p> : null}
          </Card>
        ) : null}
      </div>

      <div className="grid grid-2">
        <Card
          eyebrow="Advanced mode"
          title={advancedMode ? 'ON (auto-off in 10m)' : 'OFF'}
          subtitle="Manual trading is hidden by default and auto-disables after inactivity."
          right={
            <button className={advancedMode ? 'btn soft small' : 'btn ghost small'} onClick={() => setAdvancedMode((v) => !v)} type="button">
              {advancedMode ? 'Disable' : 'Enable'}
            </button>
          }
        >
          <p className="muted">Advanced mode gates manual actions behind extra friction to prevent accidental clicks.</p>
        </Card>

        <Card eyebrow="Manual trading" title={advancedMode ? 'Armed' : 'Hidden'} subtitle="Manual orders bypass auto strategy; use only for emergency.">
          {!advancedMode ? (
            <p className="muted">Enable Advanced mode to access manual trading controls.</p>
          ) : (
            <>
              <div className="kv-grid">
                <div className="kv">
                  <div className="label">Symbol</div>
                  <div className="value mono">{props.selectedSymbol.toUpperCase()}</div>
                </div>
                <div className="kv">
                  <div className="label">Venue</div>
                  <div className="value">{venue}</div>
                </div>
                <div className="kv">
                  <div className="label">Quote</div>
                  <div className="value">{quoteAsset || '—'}</div>
                </div>
                <div className="kv">
                  <div className="label">Suggested qty</div>
                  <div className="value">{formatCompactNumber(props.data?.strategies?.short?.entries?.[0]?.size ?? 0, { maxDecimals: 8 })}</div>
                </div>
              </div>

              <div className="actions">
                <button
                  className={tradingEnabled ? 'btn danger' : 'btn soft'}
                  onClick={() => setManualSide('BUY')}
                  disabled={manualRunning || tradeHalted}
                  type="button"
                  title={tradeHalted ? 'Trading is halted due to risk flags' : undefined}
                >
                  {tradingEnabled ? 'LIVE BUY' : 'Simulate BUY'}
                </button>
                <button
                  className={tradingEnabled ? 'btn danger' : 'btn soft'}
                  onClick={() => setManualSide('SELL')}
                  disabled={manualRunning || tradeHalted}
                  type="button"
                  title={tradeHalted ? 'Trading is halted due to risk flags' : undefined}
                >
                  {tradingEnabled ? 'LIVE SELL' : 'Simulate SELL'}
                </button>
              </div>

              {tradeHalted ? <p className="muted">Manual trades are blocked while trade halt is active.</p> : null}
            </>
          )}
        </Card>
      </div>

      <Modal
        open={dangerOpen !== null}
        danger
        title={dangerOpen === 'panic' ? 'Confirm: Panic / Flatten' : 'Confirm: Sweep unused'}
        onClose={() => (dangerRunning ? null : setDangerOpen(null))}
        actions={
          <>
            <button className="btn ghost" onClick={() => setDangerOpen(null)} disabled={dangerRunning} type="button">
              Cancel
            </button>
            <button className="btn danger" onClick={() => void onDangerAction()} disabled={dangerRunning} type="button">
              {dangerRunning ? 'Running…' : 'Confirm'}
            </button>
          </>
        }
      >
        <p className="muted">
          {dangerOpen === 'panic'
            ? venue === 'futures'
              ? 'This will MARKET-close all open futures positions (reduce-only) and enable Emergency Stop to prevent re-entry.'
              : `This will MARKET-sell free spot balances into ${props.data?.homeAsset ?? 'HOME'} where a direct market exists, and enable Emergency Stop to prevent re-entry.`
            : 'This will MARKET-sell unused free spot balances into the home asset where markets exist (locked balances and open orders are not modified).'}
        </p>
      </Modal>

      <Modal
        open={manualSide !== null}
        danger={tradingEnabled}
        title={tradingEnabled ? `LIVE ${manualSide ?? ''} confirmation` : `Simulate ${manualSide ?? ''}`}
        onClose={() => (manualRunning ? null : setManualSide(null))}
        actions={
          <>
            <button className="btn ghost" onClick={() => setManualSide(null)} disabled={manualRunning} type="button">
              Cancel
            </button>
            <button className={tradingEnabled ? 'btn danger' : 'btn primary'} onClick={() => void onManualTrade()} disabled={manualRunning || !typedOk} type="button">
              {manualRunning ? 'Placing…' : 'Confirm'}
            </button>
          </>
        }
      >
        <p className="muted">Venue: {venue} · Quote: {quoteAsset || '—'}</p>
        {tradingEnabled ? (
          <>
            <p className="muted">
              Type exactly to enable confirmation:
              <span className="mono"> {expectedTyped}</span>
            </p>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={expectedTyped ?? ''} />
            {!typedOk ? <p className="error">Typed confirmation does not match.</p> : null}
          </>
        ) : (
          <p className="muted">Trading is disabled, so this action will be simulated by the backend.</p>
        )}
        <p className="muted">Manual orders bypass auto strategy; use only for emergency.</p>
      </Modal>
    </div>
  );
};
