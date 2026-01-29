import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('risk governor state machine', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';

    process.env.RISK_GOVERNOR_ENABLED = 'true';
    process.env.RISK_WINDOW_MINUTES = '360';

    process.env.RISK_DRAWDOWN_CAUTION_PCT = '1.0';
    process.env.RISK_DRAWDOWN_HALT_PCT = '2.0';

    process.env.RISK_FEE_BURN_CAUTION_PCT = '0.20';
    process.env.RISK_FEE_BURN_HALT_PCT = '0.40';

    process.env.RISK_TREND_ADX_ON = '25';
    process.env.RISK_TREND_ADX_OFF = '18';

    // Shorten time gates for unit tests.
    process.env.RISK_MIN_STATE_SECONDS = '60';
    process.env.RISK_HALT_MIN_SECONDS = '120';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters CAUTION on drawdown and returns to NORMAL only after min-state gate', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const { __test__ } = await import('../src/services/riskGovernor.js');

    const baseline = 100;

    const d1 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: null,
      equityNow: 98.9,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d1.state).toBe('CAUTION');
    expect(d1.entriesPaused).toBe(true);
    expect(d1.since).toBe(t0.getTime());

    // Equity recovered but gate not elapsed -> should not flap back to NORMAL.
    vi.setSystemTime(new Date(t0.getTime() + 30_000));
    const d2 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: d1,
      equityNow: 100,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d2.state).toBe('CAUTION');
    expect(d2.since).toBe(t0.getTime());

    // Gate elapsed and no triggers -> NORMAL.
    vi.setSystemTime(new Date(t0.getTime() + 70_000));
    const d3 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: d2,
      equityNow: 100,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d3.state).toBe('NORMAL');
    expect(d3.entriesPaused).toBe(false);
    expect(d3.since).toBe(t0.getTime() + 70_000);
  });

  it('enters HALT on drawdown and respects halt minimum duration', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const { __test__ } = await import('../src/services/riskGovernor.js');

    const baseline = 100;

    const d1 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: null,
      equityNow: 97,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d1.state).toBe('HALT');
    expect(d1.entriesPaused).toBe(true);

    // Even if equity recovers quickly, HALT cannot be left before halt gate.
    vi.setSystemTime(new Date(t0.getTime() + 90_000));
    const d2 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: d1,
      equityNow: 100,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d2.state).toBe('HALT');
    expect(d2.since).toBe(t0.getTime());

    // After halt gate and no triggers, allow de-escalation to NORMAL.
    vi.setSystemTime(new Date(t0.getTime() + 130_000));
    const d3 = __test__.evaluateRiskGovernor({
      now: Date.now(),
      prev: d2,
      equityNow: 100,
      dailyBaseline: baseline,
      rollingBaseline: baseline,
      feeBurnPct: null,
      trend: null,
    });

    expect(d3.state).toBe('NORMAL');
    expect(d3.entriesPaused).toBe(false);
  });
});