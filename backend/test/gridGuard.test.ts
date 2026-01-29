import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet24hStats = vi.fn();
const mockGetBalances = vi.fn();
const mockGetKlines = vi.fn();
const mockGetOpenOrders = vi.fn();
const mockGetOrder = vi.fn();
const mockPlaceOrder = vi.fn();
const mockCancelOrder = vi.fn();

const mockFetchIndicatorSnapshot = vi.fn();

vi.mock('../src/binance/client.js', () => ({
  cancelOrder: mockCancelOrder,
  get24hStats: mockGet24hStats,
  getBalances: mockGetBalances,
  getKlines: mockGetKlines,
  getOpenOrders: mockGetOpenOrders,
  getOrder: mockGetOrder,
  placeOrder: mockPlaceOrder,
}));

vi.mock('../src/binance/exchangeInfo.js', () => ({
  fetchTradableSymbols: vi.fn(),
}));

vi.mock('../src/strategy/indicators.js', () => ({
  fetchIndicatorSnapshot: mockFetchIndicatorSnapshot,
}));

vi.mock('../src/services/sqlite.js', () => ({
  persistGridFill: vi.fn(),
  persistTradeFill: vi.fn(),
}));

vi.mock('../src/services/persistence.js', () => ({
  getPersistedState: () => ({ strategies: {}, lastTrades: {}, positions: {}, grids: {}, meta: {} }),
  persistGrid: vi.fn(),
  persistMeta: vi.fn(),
}));

describe('grid guard (trend / breakdown / vol) buy-pause', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.TRADE_VENUE = 'spot';
    process.env.TRADING_ENABLED = 'true';

    // Avoid interference from other safety layers.
    process.env.GRID_BREAKOUT_ACTION = 'none';
    process.env.GRID_BUY_PAUSE_ON_LIQUIDITY_HALT = 'false';
    process.env.RISK_GOVERNOR_ENABLED = 'false';

    process.env.GRID_GUARD_ENABLED = 'true';
    process.env.GRID_BREAKDOWN_PCT = '1.0';
    process.env.GRID_BREAKDOWN_TICKS = '3';
    process.env.GRID_ATR_PCT_MAX = '6.0';
    process.env.GRID_RESUME_TICKS = '3';
    process.env.GRID_RESUME_MINUTES = '5';

    process.env.RISK_TREND_ADX_ON = '25';
    process.env.RISK_TREND_ADX_OFF = '18';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses BUY legs on trend and cancels only open BUY orders', async () => {
    mockGet24hStats.mockResolvedValue({
      symbol: 'FOOUSDC',
      price: 100,
      priceChangePercent: 0,
      highPrice: 110,
      lowPrice: 90,
      volume: 0,
      quoteVolume: 10_000_000,
      updatedAt: Date.now(),
    });

    mockFetchIndicatorSnapshot.mockResolvedValue({
      close: 100,
      atr14: 5,
      adx14: 30,
      bb20: { lower: 95, upper: 105 },
    });

    mockGetOpenOrders.mockResolvedValue([{ orderId: 101, side: 'BUY', price: 95, origQty: 0.1 }]);
    mockGetOrder.mockResolvedValue({ status: 'CANCELED', side: 'BUY', executedQty: 0, price: 95, cummulativeQuoteQty: 0, type: 'LIMIT' });

    mockPlaceOrder.mockResolvedValue({ orderId: 202 });

    const { __test__ } = await import('../src/services/gridTrader.js');

    const grid = {
      symbol: 'FOOUSDC',
      status: 'running',
      baseAsset: 'FOO',
      quoteAsset: 'USDC',
      homeAsset: 'USDC',
      lowerPrice: 50,
      upperPrice: 150,
      levels: 2,
      prices: [95, 105],
      orderNotionalHome: 10,
      allocationHome: 100,
      bootstrapBasePct: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ordersByLevel: {
        '0': { orderId: 101, side: 'BUY', price: 95, quantity: 0.1, placedAt: Date.now() },
      },
      performance: {
        startAt: Date.now(),
        startValueHome: 100,
        lastAt: Date.now(),
        lastValueHome: 100,
        pnlHome: 0,
        pnlPct: 0,
        baseVirtual: 1,
        quoteVirtual: 0,
        feesHome: 0,
        fillsBuy: 0,
        fillsSell: 0,
        breakouts: 0,
      },
    };

    const info = { tickSize: 0.01, stepSize: 0.001 } as any;
    const balances = [
      { asset: 'FOO', free: 1, locked: 0 },
      { asset: 'USDC', free: 1000, locked: 0 },
    ];

    const updated = await __test__.reconcileGridOrders(grid as any, info, balances as any);

    expect(updated.buyPaused).toBe(true);
    expect(updated.buyPauseReason).toBe('trend');
    expect(typeof updated.buyPausedAt).toBe('number');

    expect(mockCancelOrder).toHaveBeenCalledTimes(1);
    expect(mockCancelOrder).toHaveBeenCalledWith('FOOUSDC', 101);

    expect(mockPlaceOrder).not.toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
    expect(Object.values(updated.ordersByLevel).some((o: any) => o.side === 'BUY')).toBe(false);
  });

  it('resumes BUY legs only after consecutive resume ticks and the time gate', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    mockGetOpenOrders.mockResolvedValue([]);
    mockGetOrder.mockResolvedValue(null);
    mockPlaceOrder.mockResolvedValue({ orderId: 303 });

    const info = { tickSize: 0.01, stepSize: 0.001 } as any;
    const balances = [
      { asset: 'FOO', free: 0, locked: 0 },
      { asset: 'USDC', free: 1000, locked: 0 },
    ];

    const { __test__ } = await import('../src/services/gridTrader.js');

    const baseGrid = {
      symbol: 'FOOUSDC',
      status: 'running',
      baseAsset: 'FOO',
      quoteAsset: 'USDC',
      homeAsset: 'USDC',
      lowerPrice: 50,
      upperPrice: 150,
      levels: 2,
      prices: [95],
      orderNotionalHome: 100,
      allocationHome: 100,
      bootstrapBasePct: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      buyPaused: true,
      buyPauseReason: 'trend',
      buyPausedAt: Date.now(),
      ordersByLevel: {},
      performance: {
        startAt: Date.now(),
        startValueHome: 100,
        lastAt: Date.now(),
        lastValueHome: 100,
        pnlHome: 0,
        pnlPct: 0,
        baseVirtual: 0,
        quoteVirtual: 1000,
        feesHome: 0,
        fillsBuy: 0,
        fillsSell: 0,
        breakouts: 0,
      },
    };

    const goodTick = async () => {
      mockGet24hStats.mockResolvedValueOnce({
        symbol: 'FOOUSDC',
        price: 100,
        priceChangePercent: 0,
        highPrice: 110,
        lowPrice: 90,
        volume: 0,
        quoteVolume: 10_000_000,
        updatedAt: Date.now(),
      });

      mockFetchIndicatorSnapshot.mockResolvedValueOnce({
        close: 100,
        atr14: 5,
        adx14: 17, // <= ADX_OFF
        bb20: { lower: 95, upper: 105 }, // price re-enters band
      });
    };

    // Tick 1: resumeOk but not enough minutes elapsed.
    await goodTick();
    const tick1 = await __test__.reconcileGridOrders(baseGrid as any, info, balances as any);
    expect(tick1.buyPaused).toBe(true);

    // Tick 2: still within time gate.
    vi.setSystemTime(new Date(t0.getTime() + 2 * 60_000));
    await goodTick();
    const tick2 = await __test__.reconcileGridOrders(tick1 as any, info, balances as any);
    expect(tick2.buyPaused).toBe(true);

    // Tick 3: time gate elapsed and resume streak reaches GRID_RESUME_TICKS -> should unpause.
    vi.setSystemTime(new Date(t0.getTime() + 6 * 60_000));
    await goodTick();
    const tick3 = await __test__.reconcileGridOrders(tick2 as any, info, balances as any);
    expect(tick3.buyPaused).toBe(false);

    // After unpause, grid is allowed to place BUY orders again (same tick).
    expect(mockPlaceOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
  });
});