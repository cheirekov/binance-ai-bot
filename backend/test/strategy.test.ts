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

const mockMarket = {
  symbol: 'BTCUSDT',
  price: 43000,
  priceChangePercent: 2.5,
  highPrice: 44000,
  lowPrice: 41000,
  volume: 120000,
  updatedAt: Date.now(),
};

const risk: RiskSettings = {
  maxPositionSizeUsdt: 200,
  riskPerTradeFraction: 0.005,
  feeRate: { maker: 0.001, taker: 0.001 },
};

describe('buildStrategyBundle', () => {
  it('creates strategies for all horizons with AI notes', async () => {
    const mocked = vi.mocked(fetchIndicatorSnapshot);
    mocked.mockImplementation(async (symbol: string, interval: string) => ({
      symbol,
      interval,
      asOf: Date.now(),
      close: mockMarket.price,
      volume: 100,
      avgVolume20: 100,
      ema20: mockMarket.price,
      ema50: mockMarket.price - 50,
      rsi14: 55,
      atr14: 100,
      adx14: 30,
      bb20: { middle: mockMarket.price, upper: mockMarket.price + 200, lower: mockMarket.price - 200, stdDev: 100 },
    }));

    const bundle = await buildStrategyBundle(mockMarket, risk, 0.5, 1, {
      symbolRules: { tickSize: 0.01, stepSize: 0.001, minNotional: 10, minQty: 0.001 },
    });

    expect(bundle.short.horizon).toBe('short');
    expect(bundle.medium.horizon).toBe('medium');
    expect(bundle.long.horizon).toBe('long');

    expect(bundle.short.aiNotes).toContain('Mock AI rationale');
    expect(bundle.medium.exitPlan.takeProfit[0]).toBeGreaterThan(bundle.medium.entries[0].priceTarget);
    expect(bundle.long.entries[0].size).toBeGreaterThan(0);
  });
});
