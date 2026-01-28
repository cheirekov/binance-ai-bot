import { describe, expect, it } from 'vitest';

import {
  computeAdx,
  computeAtr,
  computeBollingerBands,
  computeEma,
  computeRsi,
} from '../src/strategy/indicators.js';

const makeKlines = (closes: number[], options?: { highOffset?: number; lowOffset?: number; volume?: number }) => {
  const highOffset = options?.highOffset ?? 0;
  const lowOffset = options?.lowOffset ?? 0;
  const volume = options?.volume ?? 10;
  return closes.map((close, i) => {
    const openTime = i * 60_000;
    return {
      openTime,
      open: close,
      high: close + highOffset,
      low: close + lowOffset,
      close,
      volume,
      closeTime: openTime + 60_000,
    };
  });
};

describe('indicators', () => {
  it('computes stable indicators on a flat series', () => {
    const closes = Array.from({ length: 60 }, () => 100);
    const klines = makeKlines(closes, { highOffset: 0, lowOffset: 0, volume: 5 });

    expect(computeEma(closes, 20)).toBe(100);
    expect(computeEma(closes, 50)).toBe(100);
    expect(computeRsi(closes, 14)).toBe(50);
    expect(computeAtr(klines, 14)).toBe(0);
    expect(computeAdx(klines, 14)).toBe(0);

    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb.middle).toBe(100);
    expect(bb.upper).toBe(100);
    expect(bb.lower).toBe(100);
    expect(bb.stdDev).toBe(0);
  });

  it('computes deterministic ATR/RSI/ADX on a monotonic uptrend with constant true-range', () => {
    const closes = Array.from({ length: 60 }, (_, i) => i + 1); // 1..60
    const klines = makeKlines(closes, { highOffset: 0.5, lowOffset: -0.5, volume: 10 });

    // All diffs positive -> RSI should converge to 100.
    expect(computeRsi(closes, 14)).toBe(100);

    // With high/low offsets and +1 close step, true range is always 1.5 after the first bar.
    expect(computeAtr(klines, 14)).toBeCloseTo(1.5, 10);

    // +DM dominates, DX stays ~100, so ADX should be ~100.
    expect(computeAdx(klines, 14)).toBeCloseTo(100, 10);

    // Bollinger Bands on last 20 values (41..60): mean=50.5, stdev=sqrt((20^2-1)/12)
    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb.middle).toBeCloseTo(50.5, 10);
    const expectedStd = Math.sqrt((20 ** 2 - 1) / 12);
    expect(bb.stdDev).toBeCloseTo(expectedStd, 10);
    expect(bb.upper).toBeCloseTo(50.5 + 2 * expectedStd, 10);
    expect(bb.lower).toBeCloseTo(50.5 - 2 * expectedStd, 10);
  });
});

