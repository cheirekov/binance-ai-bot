import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/openai/strategist.js', () => ({
  generateAiInsight: async () => ({
    rationale: 'Mock AI rationale',
    cautions: [],
    confidence: 0.5,
  }),
}));

import { buildStrategyBundle } from '../src/strategy/engine.js';
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
    const bundle = await buildStrategyBundle(mockMarket, risk, 0.5, 1);

    expect(bundle.short.horizon).toBe('short');
    expect(bundle.medium.horizon).toBe('medium');
    expect(bundle.long.horizon).toBe('long');

    expect(bundle.short.aiNotes).toContain('Mock AI rationale');
    expect(bundle.medium.exitPlan.takeProfit[0]).toBeGreaterThan(mockMarket.price);
    expect(bundle.long.entries[0].size).toBeGreaterThan(0);
  });
});
