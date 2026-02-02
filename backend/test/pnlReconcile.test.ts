import { describe, expect, it } from 'vitest';

import { computeGridPnlDeltas, computePortfolioPnlDeltas, parseWindowMs } from '../src/services/pnlReconcile.js';

describe('pnlReconcile helpers', () => {
  it('parses window strings', () => {
    expect(parseWindowMs('24h').windowMs).toBe(24 * 60 * 60_000);
    expect(parseWindowMs('90m').windowMs).toBe(90 * 60_000);
    expect(parseWindowMs('3600').windowMs).toBe(3_600_000);
    expect(parseWindowMs('bad').windowMs).toBe(24 * 60 * 60_000);
  });

  it('computes grid realized/unrealized deltas across window', () => {
    const startAt = 5_000;
    const rows = [
      {
        at: 1_000,
        symbol: 'FOOUSDC',
        side: 'BUY',
        executedQty: 1,
        notional: 100,
        feeEst: 0,
        price: 100,
        orderId: '1',
      },
      {
        at: 10_000,
        symbol: 'FOOUSDC',
        side: 'SELL',
        executedQty: 1,
        notional: 110,
        feeEst: 0,
        price: 110,
        orderId: '2',
      },
    ];

    const priceStartBySymbol = new Map([['FOOUSDC', 105]]);
    const priceNowBySymbol = new Map([['FOOUSDC', 110]]);

    const out = computeGridPnlDeltas({ rows, startAt, priceStartBySymbol, priceNowBySymbol });
    expect(out.realizedDelta).toBeCloseTo(10);
    expect(out.unrealizedDelta).toBeCloseTo(-5);
    expect(out.feesDelta).toBeCloseTo(0);
  });

  it('computes portfolio realized/unrealized deltas across window', () => {
    const startAt = 5_000;
    const rows = [
      {
        at: 1_000,
        symbol: 'FOOUSDC',
        positionKey: 'pos-1',
        event: 'OPEN',
        side: 'BUY',
        qty: 1,
        avgPrice: 100,
        quoteAsset: 'USDC',
        homeAsset: 'USDC',
        feesHome: 1,
      },
      {
        at: 10_000,
        symbol: 'FOOUSDC',
        positionKey: 'pos-1',
        event: 'CLOSE',
        side: 'SELL',
        qty: 1,
        avgPrice: 110,
        quoteAsset: 'USDC',
        homeAsset: 'USDC',
        feesHome: 1,
        pnlHome: 10,
      },
    ];

    const priceStartBySymbol = new Map([['FOOUSDC', 105]]);
    const priceNowBySymbol = new Map([['FOOUSDC', 110]]);
    const quoteToHomeStart = new Map([['USDC', 1]]);
    const quoteToHomeNow = new Map([['USDC', 1]]);

    const out = computePortfolioPnlDeltas({
      rows,
      startAt,
      priceStartBySymbol,
      priceNowBySymbol,
      quoteToHomeStart,
      quoteToHomeNow,
      homeAsset: 'USDC',
    });

    expect(out.realizedDelta).toBeCloseTo(10);
    expect(out.unrealizedDelta).toBeCloseTo(-5);
    expect(out.feesDelta).toBeCloseTo(1);
  });
});

