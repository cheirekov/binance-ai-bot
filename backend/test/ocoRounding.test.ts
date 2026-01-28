import { describe, expect, it } from 'vitest';

import { buildOcoRoundedParams } from '../src/binance/client.js';

const decimalsIn = (value: string) => {
  const [, frac] = value.split('.');
  return frac ? frac.length : 0;
};

describe('buildOcoRoundedParams', () => {
  it('serializes strings from rounded values (step/tick) and enforces 1-tick separation for SELL', () => {
    const out = buildOcoRoundedParams({
      side: 'SELL',
      quantity: 1.234567,
      takeProfit: 100.12999,
      stopLoss: 99.87111,
      stepSize: 0.001,
      tickSize: 0.01,
    });

    // Floored to step/tick
    expect(out.qty).toBe(1.234);
    expect(out.price).toBe(100.12);
    expect(out.stopPrice).toBe(99.87);

    // Stop-limit must be at least 1 tick below stop
    expect(out.stopLimitPrice).toBeLessThan(out.stopPrice);
    expect(out.stopPrice - out.stopLimitPrice).toBeGreaterThanOrEqual(0.01);

    // String precision must not exceed step/tick precision
    expect(decimalsIn(out.qtyStr)).toBeLessThanOrEqual(3);
    expect(decimalsIn(out.priceStr)).toBeLessThanOrEqual(2);
    expect(decimalsIn(out.stopPriceStr)).toBeLessThanOrEqual(2);
    expect(decimalsIn(out.stopLimitPriceStr)).toBeLessThanOrEqual(2);

    // Strings must reflect the rounded numbers (not the raw inputs)
    expect(Number(out.qtyStr)).toBe(out.qty);
    expect(Number(out.priceStr)).toBe(out.price);
    expect(Number(out.stopPriceStr)).toBe(out.stopPrice);
    expect(Number(out.stopLimitPriceStr)).toBe(out.stopLimitPrice);
  });

  it('enforces 1-tick separation for BUY in the correct direction', () => {
    const tick = 0.1;
    const out = buildOcoRoundedParams({
      side: 'BUY',
      quantity: 10.999,
      takeProfit: 9.99,
      stopLoss: 10.05,
      stepSize: 0.1,
      tickSize: tick,
    });

    expect(out.stopLimitPrice).toBeGreaterThan(out.stopPrice);
    expect(out.stopLimitPrice - out.stopPrice).toBeGreaterThanOrEqual(tick - 1e-12);
  });
});
