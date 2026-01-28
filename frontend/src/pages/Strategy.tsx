import { useMemo, useState } from 'react';

import { applyAiTuning, startGrid, stopGrid } from '../api';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { StrategyPlan, StrategyResponse } from '../types';
import { formatCompactNumber } from '../utils/format';

const parseSignal = (plan: StrategyPlan | null | undefined, key: string) => {
  const s = plan?.signalsUsed ?? [];
  const hit = s.find((x) => x.toUpperCase().startsWith(key.toUpperCase()));
  return hit ?? null;
};

const deriveRegime = (plan: StrategyPlan | null | undefined) => {
  const hit = parseSignal(plan, 'Regime');
  if (!hit) return null;
  const parts = hit.split(' ');
  return parts[1]?.toUpperCase() ?? null;
};

export const StrategyPage = (props: { data: StrategyResponse | null; selectedSymbol: string; onSync: () => Promise<void> }) => {
  const toast = useToast();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmGrid, setConfirmGrid] = useState<null | { action: 'start' | 'stop'; symbol: string }>(null);
  const [confirmTune, setConfirmTune] = useState(false);
  const [gridRunning, setGridRunning] = useState(false);
  const [tuningRunning, setTuningRunning] = useState(false);

  const plan = props.data?.strategies?.short ?? null;
  const regime = deriveRegime(plan);
  const adx = parseSignal(plan, 'ADX14');
  const rsi = parseSignal(plan, 'RSI14');
  const atr = parseSignal(plan, 'ATR14');
  const sizeGate = (plan?.signalsUsed ?? []).find((s) => s.toUpperCase().startsWith('SIZE GATE:'));

  const why = useMemo(() => {
    const out: string[] = [];
    if (plan?.thesis) out.push(plan.thesis);
    if (sizeGate) out.push(sizeGate.replace('Size gate:', 'Sizing:'));
    const trailing = (plan?.signalsUsed ?? []).find((s) => s.toUpperCase().includes('TRAIL'));
    if (trailing) out.push(trailing);
    const aiNotes = plan?.aiNotes?.trim();
    if (aiNotes) out.push(`AI: ${aiNotes}`);
    return out.slice(0, 5);
  }, [plan?.aiNotes, plan?.signalsUsed, plan?.thesis, sizeGate]);

  const hasGrids = Object.keys(props.data?.grids ?? {}).length > 0;
  const showGridControls = !!props.data?.gridEnabled || hasGrids;
  const tune = props.data?.aiPolicy?.lastDecision?.tune ?? null;
  const hasTune = !!tune && Object.keys(tune).length > 0;

  const tuneSummary = useMemo(() => {
    if (!hasTune || !tune) return null;
    const parts: string[] = [];
    if (tune.minQuoteVolume !== undefined) parts.push(`min volume ${tune.minQuoteVolume.toLocaleString()}`);
    if (tune.maxVolatilityPercent !== undefined) parts.push(`max vol ${tune.maxVolatilityPercent}%`);
    if (tune.autoTradeHorizon) parts.push(`horizon ${tune.autoTradeHorizon}`);
    if (tune.portfolioMaxAllocPct !== undefined) parts.push(`portfolio max alloc ${tune.portfolioMaxAllocPct}%`);
    if (tune.portfolioMaxPositions !== undefined) parts.push(`portfolio max pos ${tune.portfolioMaxPositions}`);
    if (tune.gridMaxAllocPct !== undefined) parts.push(`grid max alloc ${tune.gridMaxAllocPct}%`);
    return parts.join(' · ');
  }, [hasTune, tune]);

  const onApplyTuning = async () => {
    setTuningRunning(true);
    try {
      const res = await applyAiTuning();
      if (!res.ok) {
        toast.error(res.error ?? 'AI tuning apply failed.');
      } else {
        toast.success('AI tuning applied.');
      }
      await props.onSync();
    } catch {
      toast.error('AI tuning apply failed.');
    } finally {
      setTuningRunning(false);
    }
  };

  const onConfirmGrid = async () => {
    if (!confirmGrid) return;
    setGridRunning(true);
    try {
      const fn = confirmGrid.action === 'start' ? startGrid : stopGrid;
      const res = await fn(confirmGrid.symbol);
      if (!res.ok) toast.error(res.error ?? 'Grid action failed.');
      else toast.success(confirmGrid.action === 'start' ? 'Grid started.' : 'Grid stopped.');
      setConfirmGrid(null);
      await props.onSync();
    } catch {
      toast.error('Grid action failed.');
    } finally {
      setGridRunning(false);
    }
  };

  return (
    <div className="page">
      <div className="grid grid-2">
        <Card eyebrow="Mode" title="Summary">
          <div className="chip-row">
            <Chip tone="info">Venue: {props.data?.tradeVenue ?? 'spot'}</Chip>
            <Chip tone={props.data?.aiPolicyMode && props.data.aiPolicyMode !== 'off' ? 'good' : 'neutral'}>AI: {props.data?.aiPolicyMode ?? 'off'}</Chip>
            <Chip tone={props.data?.gridEnabled ? 'good' : 'neutral'}>Grid: {props.data?.gridEnabled ? 'On' : 'Off'}</Chip>
            <Chip tone={props.data?.portfolioEnabled ? 'good' : 'neutral'}>Portfolio: {props.data?.portfolioEnabled ? 'On' : 'Off'}</Chip>
          </div>
          <p className="muted">This page explains the current signal in plain language; advanced data is collapsed by default.</p>
        </Card>

        <Card eyebrow="Signal" title={props.selectedSymbol.toUpperCase()} subtitle="Short-horizon plan">
          {plan ? (
            <>
              <div className="kv-grid">
                <div className="kv">
                  <div className="label">Regime</div>
                  <div className="value">{regime ?? '—'}</div>
                </div>
                <div className="kv">
                  <div className="label">ADX</div>
                  <div className="value">{adx?.replace('ADX14 ', '') ?? '—'}</div>
                </div>
                <div className="kv">
                  <div className="label">RSI</div>
                  <div className="value">{rsi?.replace('RSI14 ', '') ?? '—'}</div>
                </div>
                <div className="kv">
                  <div className="label">ATR</div>
                  <div className="value">{atr?.replace('ATR14 ', '') ?? '—'}</div>
                </div>
              </div>
              {why.length ? (
                <ul className="bullets">
                  {why.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="muted">No strategy bundle yet. Use “Refresh now” on Home.</p>
          )}
          <div className="actions">
            {hasTune ? (
              <button className="btn soft" onClick={() => setConfirmTune(true)} disabled={tuningRunning} type="button" title="Applies the last AI tuning suggestion (if present)">
                {tuningRunning ? 'Applying…' : 'Apply AI tuning'}
              </button>
            ) : null}
            <button className="btn ghost" onClick={() => setAdvancedOpen(true)} type="button">
              Advanced
            </button>
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card eyebrow="Universe" title="Ranked candidates" subtitle="Only shown when backend provides candidates">
          {props.data?.rankedCandidates?.length ? (
            <div className="stack">
              {props.data.rankedCandidates.slice(0, 10).map((c) => (
                <div key={c.symbol} className="candidate-row">
                  <span className="mono">{c.symbol}</span>
                  <span className="muted">score {formatCompactNumber(c.score, { maxDecimals: 4 })}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No candidate list available.</p>
          )}
          {props.data?.rankedGridCandidates?.length ? (
            <>
              <div className="divider" />
              <p className="label">Grid candidates</p>
              <div className="stack">
                {props.data.rankedGridCandidates.slice(0, 10).map((c) => (
                  <div key={c.symbol} className="candidate-row">
                    <span className="mono">{c.symbol}</span>
                    <span className="muted">score {formatCompactNumber(c.score, { maxDecimals: 4 })}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </Card>

        {showGridControls ? (
          <Card eyebrow="Grid" title="Spot-only automation" subtitle={props.data?.tradeVenue === 'futures' ? 'Unavailable in futures mode' : props.data?.gridEnabled ? 'Enabled' : 'Disabled'}>
            {props.data?.tradeVenue === 'futures' ? (
              <p className="muted">Grid trading is spot-only.</p>
            ) : (
              <>
                <p className="muted">Grid controls are shown only when grid mode is enabled or an active grid exists.</p>
                <div className="actions">
                  <button className="btn soft" onClick={() => setConfirmGrid({ action: 'start', symbol: props.selectedSymbol.toUpperCase() })} disabled={gridRunning} type="button">
                    Start grid
                  </button>
                  <button className="btn soft" onClick={() => setConfirmGrid({ action: 'stop', symbol: props.selectedSymbol.toUpperCase() })} disabled={gridRunning} type="button">
                    Stop grid
                  </button>
                </div>
                {hasGrids ? (
                  <div className="stack">
                    {Object.values(props.data?.grids ?? {}).map((g) => (
                      <div key={g.symbol} className="candidate-row">
                        <span className="mono">{g.symbol}</span>
                        <span className="muted">{g.status}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No active grids.</p>
                )}
              </>
            )}
          </Card>
        ) : (
          <Card eyebrow="Grid" title="Hidden" subtitle="Grid is disabled and there are no active grids">
            <p className="muted">Enable grid mode on the backend to see grid controls.</p>
          </Card>
        )}
      </div>

      <Modal
        open={advancedOpen}
        title="Advanced details"
        onClose={() => setAdvancedOpen(false)}
        actions={
          <button className="btn soft" onClick={() => setAdvancedOpen(false)} type="button">
            Close
          </button>
        }
      >
        <div className="stack">
          <div>
            <div className="label">Signals (short horizon)</div>
            <div className="pre">
              <pre>{(plan?.signalsUsed ?? []).join('\n') || '—'}</pre>
            </div>
          </div>
          <div>
            <div className="label">AI policy (raw)</div>
            <div className="pre">
              <pre>{JSON.stringify(props.data?.aiPolicy ?? null, null, 2)}</pre>
            </div>
          </div>
          <div>
            <div className="label">Runtime overrides (raw)</div>
            <div className="pre">
              <pre>{JSON.stringify(props.data?.runtimeConfig ?? null, null, 2)}</pre>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmGrid}
        danger={confirmGrid?.action === 'stop'}
        title={confirmGrid?.action === 'start' ? 'Start grid' : 'Stop grid'}
        onClose={() => (gridRunning ? null : setConfirmGrid(null))}
        actions={
          <>
            <button className="btn ghost" onClick={() => setConfirmGrid(null)} disabled={gridRunning} type="button">
              Cancel
            </button>
            <button className={confirmGrid?.action === 'stop' ? 'btn danger' : 'btn primary'} onClick={() => void onConfirmGrid()} disabled={gridRunning} type="button">
              {gridRunning ? 'Working…' : 'Confirm'}
            </button>
          </>
        }
      >
        <p className="muted">
          {confirmGrid?.action === 'start'
            ? 'Starts a spot grid on the current symbol. Grid orders will be managed by the bot.'
            : 'Stops the grid and cancels tracked grid orders.'}
        </p>
      </Modal>

      <Modal
        open={confirmTune}
        title="Apply AI tuning"
        onClose={() => (tuningRunning ? null : setConfirmTune(false))}
        actions={
          <>
            <button className="btn ghost" onClick={() => setConfirmTune(false)} disabled={tuningRunning} type="button">
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => void onApplyTuning().finally(() => setConfirmTune(false))}
              disabled={tuningRunning}
              type="button"
            >
              {tuningRunning ? 'Applying…' : 'Confirm'}
            </button>
          </>
        }
      >
        <p className="muted">This updates the bot’s runtime settings immediately and persists them in state.</p>
        <p className="muted">{tuneSummary ? `Suggested: ${tuneSummary}` : 'Suggested: (none)'}</p>
      </Modal>
    </div>
  );
};
