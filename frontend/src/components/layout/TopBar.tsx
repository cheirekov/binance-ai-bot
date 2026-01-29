import { StrategyResponse } from '../../types';
import { formatAgo } from '../../utils/time';
import { Chip } from '../ui/Chip';
import type { NavTabId } from './BottomNav';

const venueLabel = (venue?: StrategyResponse['tradeVenue']) => {
  if (venue === 'futures') return 'Futures';
  return 'Spot';
};

export const TopBar = (props: {
  appName: string;
  data: StrategyResponse | null;
  loading: boolean;
  selectedSymbol: string;
  availableSymbols: string[];
  onSelectSymbol: (symbol: string) => void;
  lastSuccessAt: number | null;
  apiHealth: { status: 'idle' | 'ok' | 'error'; title?: string };
  nav?: { active: NavTabId; tabs: Array<{ id: NavTabId; label: string; disabled?: boolean }>; onChange: (id: NavTabId) => void };
}) => {
  const tradingEnabled = !!props.data?.tradingEnabled;
  const autoTradeEnabled = !!props.data?.autoTradeEnabled;
  const emergencyStop = !!props.data?.emergencyStop;
  const tradeHalted = !!props.data?.tradeHalted;
  const venue = props.data?.tradeVenue;

  const liveBanner = tradingEnabled ? (
    <div className="banner banner-live" role="status">
      LIVE TRADING ENABLED
    </div>
  ) : null;

  const haltBanner = emergencyStop || tradeHalted ? (
    <div className="banner banner-halt" role="status">
      TRADING HALTED / EMERGENCY STOP
    </div>
  ) : null;

  const apiTone = props.apiHealth.status === 'ok' ? 'good' : props.apiHealth.status === 'error' ? 'danger' : 'neutral';
  const apiLabel = props.apiHealth.status === 'ok' ? 'API OK' : props.apiHealth.status === 'error' ? 'API ERROR' : 'API …';

  return (
    <div className="topbar">
      {liveBanner}
      {haltBanner}
      <div className="topbar-row">
        <div className="topbar-left">
          <div className="brand">{props.appName}</div>
          <label className="sr-only" htmlFor="topbar-symbol">
            Symbol
          </label>
          <select
            id="topbar-symbol"
            className="select select-compact"
            value={props.selectedSymbol}
            onChange={(e) => props.onSelectSymbol(e.target.value)}
            disabled={props.loading || !props.availableSymbols.length}
          >
            {props.availableSymbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="topbar-right">
          <div className="topbar-meta">
            <span className="muted">{props.lastSuccessAt ? `Updated ${formatAgo(props.lastSuccessAt)}` : props.loading ? 'Connecting…' : '—'}</span>
            <Chip tone={apiTone} title={props.apiHealth.title}>
              {apiLabel}
            </Chip>
          </div>
          <div className="topbar-chips">
            <Chip tone={tradingEnabled ? 'danger' : 'good'} title={tradingEnabled ? 'Real orders can be placed' : 'Orders are simulated unless trading is enabled'}>
              {tradingEnabled ? 'LIVE' : 'SIM'}
            </Chip>
            <Chip tone={autoTradeEnabled ? (emergencyStop ? 'warn' : 'good') : 'neutral'} title={autoTradeEnabled ? (emergencyStop ? 'Auto-trade paused by emergency stop' : 'Auto-trade enabled') : 'Auto-trade disabled'}>
              Auto {autoTradeEnabled ? (emergencyStop ? 'Paused' : 'On') : 'Off'}
            </Chip>
            <Chip tone="info" title="Trade venue">
              {venueLabel(venue)}
            </Chip>
            {emergencyStop ? (
              <Chip tone="warn" title={props.data?.emergencyStopReason ? `Reason: ${props.data.emergencyStopReason}` : undefined}>
                E‑Stop
              </Chip>
            ) : null}
            {tradeHalted ? (
              <Chip tone="warn" title={props.data?.riskFlags?.length ? props.data.riskFlags.join(' • ') : 'Risk flags'}>
                Halted
              </Chip>
            ) : null}
          </div>
        </div>
      </div>
      {props.nav ? (
        <nav className="top-tabs desktop-only" aria-label="Primary">
          {props.nav.tabs.map((t) => (
            <button
              key={t.id}
              className={t.id === props.nav?.active ? 'tab active' : 'tab'}
              onClick={() => props.nav?.onChange(t.id)}
              disabled={t.disabled}
              type="button"
              title={t.disabled ? 'Unavailable in current mode' : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
};
