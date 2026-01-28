import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/openai/strategist.js', () => ({
  generateAiInsight: async () => ({
    rationale: 'Mock AI rationale',
    cautions: [],
    confidence: 0.5,
  }),
}));

vi.mock('../src/strategy/indicators.js', () => ({
  fetchIndicatorSnapshot: vi.fn(),
}));

import { buildStrategyBundle } from '../src/strategy/engine.js';
import { fetchIndicatorSnapshot } from '../src/strategy/indicators.js';
import { RiskSettings } from '../src/types.js';

const risk: RiskSettings = {
  maxPositionSizeUsdt: 200,
  riskPerTradeFraction: 0.005,
  feeRate: { maker: 0.001, taker: 0.001 },
};

describe('regime-based engine', () => {
  it('blocks TREND entries when RSI is out of range', async () => {
    const market = {
      symbol: 'FOOUSDT',
      price: 100,
      priceChangePercent: 0,
      highPrice: 101,
      lowPrice: 99,
      volume: 1000,
      updatedAt: Date.now(),
    };

    vi.mocked(fetchIndicatorSnapshot).mockImplementation(async (symbol: string, interval: string) => ({
      symbol,
      interval,
      asOf: Date.now(),
      close: 100,
      volume: 100,
      avgVolume20: 100,
      ema20: 101,
      ema50: 99,
      rsi14: 75, // too high
      atr14: 2,
      adx14: 30,
      bb20: { middle: 100, upper: 104, lower: 96, stdDev: 2 },
    }));

    const bundle = await buildStrategyBundle(market, risk, 0, 1, {
      useAi: false,
      symbolRules: { tickSize: 0.1, stepSize: 0.01, minNotional: 10, minQty: 0.01 },
    });

    expect(bundle.short.entries[0].side).toBe('BUY');
    expect(bundle.short.entries[0].size).toBe(0);
    expect(bundle.short.entries[0].confidence).toBeLessThanOrEqual(0.5);
  });

  it('produces RANGE BUY entries near the lower Bollinger band (spot long-only)', async () => {
    const market = {
      symbol: 'FOOUSDT',
      price: 95,
      priceChangePercent: 0,
      highPrice: 100,
      lowPrice: 90,
      volume: 1000,
      updatedAt: Date.now(),
    };

    vi.mocked(fetchIndicatorSnapshot).mockImplementation(async (symbol: string, interval: string) => ({
      symbol,
      interval,
      asOf: Date.now(),
      close: 95,
      volume: 120,
      avgVolume20: 100,
      ema20: 97,
      ema50: 98,
      rsi14: 30,
      atr14: 2,
      adx14: 10, // RANGE
      bb20: { middle: 100, upper: 105, lower: 95, stdDev: 2.5 },
    }));

    const bundle = await buildStrategyBundle(market, risk, 0, 1, {
      useAi: false,
      symbolRules: { tickSize: 0.1, stepSize: 0.01, minNotional: 10, minQty: 0.01 },
    });

    const plan = bundle.short;
    expect(plan.entries[0].side).toBe('BUY');
    expect(plan.entries[0].size).toBeGreaterThan(0);
    expect(plan.exitPlan.stopLoss).toBeLessThan(plan.entries[0].priceTarget);
    expect(plan.exitPlan.takeProfit[0]).toBeGreaterThan(plan.entries[0].priceTarget);
    expect(plan.exitPlan.takeProfit[0]).toBe(105); // ATR pct high => target upper band
  });

  it('applies minNotional as a hard gate in sizing', async () => {
    const market = {
      symbol: 'FOOUSDT',
      price: 95,
      priceChangePercent: 0,
      highPrice: 100,
      lowPrice: 90,
      volume: 1000,
      updatedAt: Date.now(),
    };

    vi.mocked(fetchIndicatorSnapshot).mockImplementation(async (symbol: string, interval: string) => ({
      symbol,
      interval,
      asOf: Date.now(),
      close: 95,
      volume: 120,
      avgVolume20: 100,
      ema20: 97,
      ema50: 98,
      rsi14: 30,
      atr14: 2,
      adx14: 10,
      bb20: { middle: 100, upper: 105, lower: 95, stdDev: 2.5 },
    }));

    const bundle = await buildStrategyBundle(market, risk, 0, 1, {
      useAi: false,
      symbolRules: { tickSize: 0.1, stepSize: 0.01, minNotional: 10_000, minQty: 0.01 },
    });

    expect(bundle.short.entries[0].size).toBe(0);
    expect(bundle.short.signalsUsed.join(' | ')).toContain('below_min_notional');
  });
});

