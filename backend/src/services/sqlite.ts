import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { get24hStats, getKlines } from '../binance/client.js';
import { fetchTradableSymbols } from '../binance/exchangeInfo.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';
import { getPersistedState } from './persistence.js';
import { computeFillPnlDeltasBySymbol, computeGridPnlDeltas, computePortfolioPnlDeltas, parseWindowMs } from './pnlReconcile.js';

type SqliteDb = {
  pragma: (value: string) => void;
  exec: (sql: string) => void;
  // better-sqlite3 Statement#run returns a result object with `.changes` and `.lastInsertRowid`.
  prepare: (sql: string) => {
    run: (params?: Record<string, unknown>) => { changes: number };
    get: () => Record<string, unknown> | undefined;
    all: () => Array<Record<string, unknown>>;
  };
  transaction: <T>(fn: (arg: T) => void) => (arg: T) => void;
};

type QueuedWrite = (db: SqliteDb) => void;

let db: SqliteDb | null = null;
let lastOpenErrorAt: number | null = null;
let lastOpenError: string | null = null;
let openDisabledUntil: number | null = null;

const queue: QueuedWrite[] = [];
let flushScheduled = false;
let lastWriteAt: number | null = null;
let lastWriteError: string | null = null;

const MAX_QUEUE = 2_000;
const FLUSH_BATCH = 200;

const ensureDirFor = (filePath: string) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.warn({ err: errorToLogObject(error), path: filePath }, 'SQLite: failed to ensure directory');
  }
};

const migrateTradesTable = (db: SqliteDb) => {
  try {
    const cols = db
      .prepare(`PRAGMA table_info(trades)`)
      .all()
      .map((r) => String(r.name ?? ''));
    const has = new Set(cols);

    const addColumn = (name: string, decl: string) => {
      if (has.has(name)) return;
      db.exec(`ALTER TABLE trades ADD COLUMN ${decl}`);
      has.add(name);
    };

    addColumn('module', 'module TEXT');
    addColumn('price', 'price REAL');
    addColumn('notional', 'notional REAL');
    addColumn('feeAsset', 'feeAsset TEXT');
    addColumn('feeAmount', 'feeAmount REAL');
    addColumn('tradeId', 'tradeId TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_module_at
        ON trades(module, at);

      CREATE INDEX IF NOT EXISTS idx_trades_orderId
        ON trades(orderId);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_symbol_tradeId
        ON trades(symbol, tradeId)
        WHERE tradeId IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_fill_agg
        ON trades(symbol, module, side, orderId, event)
        WHERE tradeId IS NULL AND orderId IS NOT NULL AND event='FILL';
    `);
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'SQLite: failed to migrate trades table');
  }
};

const initSchema = (db: SqliteDb) => {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_features (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      avgVolume20 REAL,
      ema20 REAL,
      ema50 REAL,
      rsi14 REAL,
      atr14 REAL,
      adx14 REAL,
      bbMiddle REAL,
      bbUpper REAL,
      bbLower REAL
    );

    CREATE INDEX IF NOT EXISTS idx_market_features_symbol_at
      ON market_features(symbol, at);

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      horizon TEXT,
      action TEXT NOT NULL,
      confidence REAL,
      reason TEXT,
      mode TEXT,
      orderId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_symbol_at
      ON decisions(symbol, at);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      module TEXT,
      positionKey TEXT,
      event TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      avgPrice REAL NOT NULL,
      price REAL,
      notional REAL,
      quoteAsset TEXT,
      homeAsset TEXT,
      feeAsset TEXT,
      feeAmount REAL,
      feesHome REAL,
      pnlHome REAL,
      netPnlHome REAL,
      orderId TEXT,
      tradeId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trades_symbol_at
      ON trades(symbol, at);

    CREATE INDEX IF NOT EXISTS idx_trades_event_at
      ON trades(event, at);

    CREATE TABLE IF NOT EXISTS grid_fills (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      executedQty REAL NOT NULL,
      notional REAL NOT NULL,
      feeEst REAL,
      price REAL,
      orderId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_grid_fills_symbol_at
      ON grid_fills(symbol, at);

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      homeAsset TEXT NOT NULL,
      equityHome REAL NOT NULL,
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_equity_snapshots_at
      ON equity_snapshots(at);

    CREATE TABLE IF NOT EXISTS conversion_events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      fromAsset TEXT,
      toAsset TEXT,
      fromQty REAL,
      toQty REAL,
      homeAsset TEXT,
      homeNotional REAL,
      feeEstHome REAL,
      slippageEstHome REAL,
      lossEstHome REAL,
      orderId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conversion_events_at
      ON conversion_events(at);
  `);

  migrateTradesTable(db);
};

const openDb = (): SqliteDb | null => {
  if (!config.persistToSqlite) return null;
  const now = Date.now();
  if (openDisabledUntil && now < openDisabledUntil) return null;

  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as new (file: string) => SqliteDb;
    ensureDirFor(config.sqlitePath);
    const next = new Database(config.sqlitePath);
    initSchema(next);
    lastOpenErrorAt = null;
    lastOpenError = null;
    openDisabledUntil = null;
    return next;
  } catch (error) {
    lastOpenErrorAt = now;
    lastOpenError = error instanceof Error ? error.message.slice(0, 180) : 'Unknown error';
    // Back off briefly to avoid spamming logs if the filesystem is unwritable.
    openDisabledUntil = now + 30_000;
    logger.warn({ err: errorToLogObject(error) }, 'SQLite: failed to open (disabled temporarily)');
    return null;
  }
};

const ensureDb = (): SqliteDb | null => {
  if (!config.persistToSqlite) return null;
  if (db) return db;
  db = openDb();
  return db;
};

const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    flushQueue();
  }, 0);
};

const flushQueue = () => {
  const active = ensureDb();
  if (!active) {
    // Drop queued writes if SQLite is disabled/unavailable to avoid unbounded memory growth.
    queue.splice(0, queue.length);
    return;
  }

  let processed = 0;
  while (queue.length && processed < FLUSH_BATCH) {
    const batch = queue.splice(0, Math.min(FLUSH_BATCH - processed, queue.length));
    processed += batch.length;
    try {
      const tx = active.transaction((writes: QueuedWrite[]) => {
        for (const w of writes) w(active);
      });
      tx(batch);
      lastWriteAt = Date.now();
      lastWriteError = null;
    } catch (error) {
      lastWriteError = error instanceof Error ? error.message.slice(0, 180) : 'Write batch failed';
      logger.warn({ err: errorToLogObject(error) }, 'SQLite: write batch failed (dropping batch)');
    }
  }

  if (queue.length) scheduleFlush();
};

const enqueueWrite = (write: QueuedWrite) => {
  if (!config.persistToSqlite) return;
  if (queue.length >= MAX_QUEUE) {
    queue.splice(0, Math.max(1, Math.floor(MAX_QUEUE / 10)));
    logger.warn({ dropped: true }, 'SQLite: write queue overflow (dropping oldest)');
  }
  queue.push(write);
  scheduleFlush();
};

export const initSqliteBestEffort = () => {
  if (!config.persistToSqlite) return;
  try {
    void ensureDb();
  } catch {
    // ignore
  }
};

export const persistMarketFeatures = (row: {
  at: number;
  symbol: string;
  interval: string;
  close: number;
  volume: number;
  avgVolume20?: number | null;
  ema20?: number | null;
  ema50?: number | null;
  rsi14?: number | null;
  atr14?: number | null;
  adx14?: number | null;
  bbMiddle?: number | null;
  bbUpper?: number | null;
  bbLower?: number | null;
}) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO market_features (at, symbol, interval, close, volume, avgVolume20, ema20, ema50, rsi14, atr14, adx14, bbMiddle, bbUpper, bbLower)
       VALUES (@at, @symbol, @interval, @close, @volume, @avgVolume20, @ema20, @ema50, @rsi14, @atr14, @adx14, @bbMiddle, @bbUpper, @bbLower)`,
    ).run({
      ...row,
      symbol: row.symbol.toUpperCase(),
    });
  });
};

export const persistDecision = (row: {
  at: number;
  symbol: string;
  horizon?: string;
  action: string;
  confidence?: number;
  reason?: string;
  mode?: string;
  orderId?: string | number;
}) => {
  enqueueWrite((db) => {
    const stmt = db.prepare(
      `INSERT INTO decisions (at, symbol, horizon, action, confidence, reason, mode, orderId)
       VALUES (@at, @symbol, @horizon, @action, @confidence, @reason, @mode, @orderId)`,
    );

    const params = {
      at: row.at,
      symbol: row.symbol.toUpperCase(),
      horizon: row.horizon ?? null,
      action: row.action,
      confidence: row.confidence ?? null,
      reason: row.reason ?? null,
      mode: row.mode ?? null,
      orderId: row.orderId !== undefined ? String(row.orderId) : null,
    };

    stmt.run(params);
  });
};

export const persistTrade = (row: {
  at: number;
  symbol: string;
  module?: 'grid' | 'portfolio';
  positionKey?: string;
  event: 'OPEN' | 'CLOSE';
  side: string;
  qty: number;
  avgPrice: number;
  price?: number;
  notional?: number;
  quoteAsset?: string;
  homeAsset?: string;
  feeAsset?: string;
  feeAmount?: number;
  feesHome?: number;
  pnlHome?: number;
  netPnlHome?: number;
  orderId?: string | number;
}) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO trades (at, symbol, module, positionKey, event, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feeAsset, feeAmount, feesHome, pnlHome, netPnlHome, orderId, tradeId)
       VALUES (@at, @symbol, @module, @positionKey, @event, @side, @qty, @avgPrice, @price, @notional, @quoteAsset, @homeAsset, @feeAsset, @feeAmount, @feesHome, @pnlHome, @netPnlHome, @orderId, @tradeId)`,
    ).run({
      ...row,
      symbol: row.symbol.toUpperCase(),
      module: row.module ?? 'portfolio',
      price: row.price ?? row.avgPrice,
      notional: row.notional ?? row.qty * row.avgPrice,
      feeAsset: row.feeAsset ? row.feeAsset.toUpperCase() : null,
      orderId: row.orderId !== undefined ? String(row.orderId) : null,
      tradeId: null,
    });
  });
};

export const persistTradeFill = (row: {
  at: number;
  symbol: string;
  module: 'grid' | 'portfolio';
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  notional: number;
  feeAsset?: string;
  feeAmount?: number;
  feesHome?: number;
  quoteAsset?: string;
  homeAsset?: string;
  orderId?: string | number;
  tradeId?: string | number;
}) => {
  enqueueWrite((db) => {
    const symbol = row.symbol.toUpperCase();
    const module = row.module;
    const side = String(row.side ?? '').toUpperCase();
    const qty = row.qty;
    const price = row.price;
    const notional = row.notional;
    const orderId = row.orderId !== undefined ? String(row.orderId) : null;
    const tradeId = row.tradeId !== undefined && row.tradeId !== null ? String(row.tradeId) : null;

    const params = {
      at: row.at,
      symbol,
      module,
      event: 'FILL',
      side,
      qty,
      avgPrice: price,
      price,
      notional,
      quoteAsset: row.quoteAsset ? row.quoteAsset.toUpperCase() : null,
      homeAsset: row.homeAsset ? row.homeAsset.toUpperCase() : null,
      feeAsset: row.feeAsset ? row.feeAsset.toUpperCase() : null,
      feeAmount: row.feeAmount ?? null,
      feesHome: row.feesHome ?? null,
      orderId,
      tradeId,
    };

    if (tradeId) {
      db.prepare(
        `INSERT OR IGNORE INTO trades (at, symbol, module, event, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feeAsset, feeAmount, feesHome, orderId, tradeId)
         VALUES (@at, @symbol, @module, @event, @side, @qty, @avgPrice, @price, @notional, @quoteAsset, @homeAsset, @feeAsset, @feeAmount, @feesHome, @orderId, @tradeId)`,
      ).run(params);
      return;
    }

    db.prepare(
      `INSERT INTO trades (at, symbol, module, event, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feeAsset, feeAmount, feesHome, orderId, tradeId)
       SELECT @at, @symbol, @module, @event, @side, @qty, @avgPrice, @price, @notional, @quoteAsset, @homeAsset, @feeAsset, @feeAmount, @feesHome, @orderId, @tradeId
       WHERE NOT EXISTS (
         SELECT 1 FROM trades t
         WHERE t.symbol=@symbol AND t.module=@module AND t.orderId=@orderId AND t.event='FILL' AND t.tradeId IS NOT NULL
       )
       ON CONFLICT(symbol, module, side, orderId, event) WHERE tradeId IS NULL AND orderId IS NOT NULL AND event='FILL'
       DO UPDATE SET
         at=excluded.at,
         qty=CASE WHEN excluded.qty > trades.qty THEN excluded.qty ELSE trades.qty END,
         notional=CASE WHEN excluded.notional > trades.notional THEN excluded.notional ELSE trades.notional END,
         avgPrice=excluded.avgPrice,
         price=excluded.price,
         quoteAsset=COALESCE(excluded.quoteAsset, trades.quoteAsset),
         homeAsset=COALESCE(excluded.homeAsset, trades.homeAsset),
         feeAsset=COALESCE(excluded.feeAsset, trades.feeAsset),
         feeAmount=COALESCE(excluded.feeAmount, trades.feeAmount),
         feesHome=COALESCE(excluded.feesHome, trades.feesHome)
       WHERE NOT EXISTS (
         SELECT 1 FROM trades t
         WHERE t.symbol=@symbol AND t.module=@module AND t.orderId=@orderId AND t.event='FILL' AND t.tradeId IS NOT NULL
       )`,
    ).run(params);
  });
};

export const persistTradeFillsBatch = (params: {
  fills: Array<{
    at: number;
    symbol: string;
    module: 'grid' | 'portfolio';
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    notional: number;
    feeAsset?: string;
    feeAmount?: number;
    feesHome?: number;
    quoteAsset?: string;
    homeAsset?: string;
    orderId?: string | number;
    tradeId?: string | number;
  }>;
  log?: { symbol: string; orderId: string | number; module: 'grid' | 'portfolio' };
}) => {
  if (!params.fills.length) return;

  enqueueWrite((db) => {
    const withIdStmt = db.prepare(
      `INSERT OR IGNORE INTO trades (at, symbol, module, event, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feeAsset, feeAmount, feesHome, orderId, tradeId)
       VALUES (@at, @symbol, @module, @event, @side, @qty, @avgPrice, @price, @notional, @quoteAsset, @homeAsset, @feeAsset, @feeAmount, @feesHome, @orderId, @tradeId)`,
    );

    const noIdStmt = db.prepare(
      `INSERT INTO trades (at, symbol, module, event, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feeAsset, feeAmount, feesHome, orderId, tradeId)
       SELECT @at, @symbol, @module, @event, @side, @qty, @avgPrice, @price, @notional, @quoteAsset, @homeAsset, @feeAsset, @feeAmount, @feesHome, @orderId, @tradeId
       WHERE NOT EXISTS (
         SELECT 1 FROM trades t
         WHERE t.symbol=@symbol AND t.module=@module AND t.orderId=@orderId AND t.event='FILL' AND t.tradeId IS NOT NULL
       )
       ON CONFLICT(symbol, module, side, orderId, event) WHERE tradeId IS NULL AND orderId IS NOT NULL AND event='FILL'
       DO UPDATE SET
         at=excluded.at,
         qty=CASE WHEN excluded.qty > trades.qty THEN excluded.qty ELSE trades.qty END,
         notional=CASE WHEN excluded.notional > trades.notional THEN excluded.notional ELSE trades.notional END,
         avgPrice=excluded.avgPrice,
         price=excluded.price,
         quoteAsset=COALESCE(excluded.quoteAsset, trades.quoteAsset),
         homeAsset=COALESCE(excluded.homeAsset, trades.homeAsset),
         feeAsset=COALESCE(excluded.feeAsset, trades.feeAsset),
         feeAmount=COALESCE(excluded.feeAmount, trades.feeAmount),
         feesHome=COALESCE(excluded.feesHome, trades.feesHome)
       WHERE NOT EXISTS (
         SELECT 1 FROM trades t
         WHERE t.symbol=@symbol AND t.module=@module AND t.orderId=@orderId AND t.event='FILL' AND t.tradeId IS NOT NULL
       )`,
    );

    const deleteAggStmt = db.prepare(
      `DELETE FROM trades
       WHERE symbol=@symbol AND module=@module AND orderId=@orderId AND event='FILL' AND tradeId IS NULL`,
    );

    let inserted = 0;
    let skipped = 0;
    const deleteAggFor = new Map<string, { symbol: string; module: string; orderId: string }>();

    for (const fill of params.fills) {
      const symbol = fill.symbol.toUpperCase();
      const module = fill.module;
      const side = String(fill.side ?? '').toUpperCase();
      const qty = fill.qty;
      const price = fill.price;
      const notional = fill.notional;
      const orderId = fill.orderId !== undefined ? String(fill.orderId) : null;
      const tradeId = fill.tradeId !== undefined && fill.tradeId !== null ? String(fill.tradeId) : null;

      const stmtParams = {
        at: fill.at,
        symbol,
        module,
        event: 'FILL',
        side,
        qty,
        avgPrice: price,
        price,
        notional,
        quoteAsset: fill.quoteAsset ? fill.quoteAsset.toUpperCase() : null,
        homeAsset: fill.homeAsset ? fill.homeAsset.toUpperCase() : null,
        feeAsset: fill.feeAsset ? fill.feeAsset.toUpperCase() : null,
        feeAmount: fill.feeAmount ?? null,
        feesHome: fill.feesHome ?? null,
        orderId,
        tradeId,
      } as Record<string, unknown>;

      const res = tradeId ? withIdStmt.run(stmtParams) : noIdStmt.run(stmtParams);
      if (res?.changes) {
        inserted += Number(res.changes) || 0;
      } else {
        skipped += 1;
      }

      if (tradeId && orderId) {
        deleteAggFor.set(`${symbol}:${module}:${orderId}`, { symbol, module, orderId });
      }
    }

    for (const del of deleteAggFor.values()) {
      deleteAggStmt.run({ symbol: del.symbol, module: del.module, orderId: del.orderId });
    }

    if (params.log) {
      const symbol = params.log.symbol.toUpperCase();
      const orderId = String(params.log.orderId);
      logger.info(
        {
          symbol,
          orderId,
          module: params.log.module,
          inserted,
          skippedDuplicates: skipped,
        },
        `trade-sync: symbol=${symbol} orderId=${orderId} inserted=${inserted}`,
      );
    }
  });
};

export const persistGridFill = (row: {
  at: number;
  symbol: string;
  side: string;
  executedQty: number;
  notional: number;
  feeEst?: number;
  price?: number;
  orderId?: string | number;
}) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO grid_fills (at, symbol, side, executedQty, notional, feeEst, price, orderId)
       VALUES (@at, @symbol, @side, @executedQty, @notional, @feeEst, @price, @orderId)`,
    ).run({
      at: row.at,
      symbol: row.symbol.toUpperCase(),
      side: String(row.side ?? '').toUpperCase(),
      executedQty: row.executedQty,
      notional: row.notional,
      feeEst: row.feeEst ?? null,
      price: row.price ?? null,
      orderId: row.orderId !== undefined ? String(row.orderId) : null,
    });
  });
};

export const persistEquitySnapshot = (row: { at: number; homeAsset: string; equityHome: number; source?: string }) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO equity_snapshots (at, homeAsset, equityHome, source)
       VALUES (@at, @homeAsset, @equityHome, @source)`,
    ).run({
      at: row.at,
      homeAsset: row.homeAsset.toUpperCase(),
      equityHome: row.equityHome,
      source: row.source ?? null,
    });
  });
};

export const persistConversionEvent = (row: {
  at: number;
  symbol: string;
  side: string;
  fromAsset?: string;
  toAsset?: string;
  fromQty?: number;
  toQty?: number;
  homeAsset?: string;
  homeNotional?: number;
  feeEstHome?: number;
  slippageEstHome?: number;
  lossEstHome?: number;
  orderId?: string | number;
}) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO conversion_events (at, symbol, side, fromAsset, toAsset, fromQty, toQty, homeAsset, homeNotional, feeEstHome, slippageEstHome, lossEstHome, orderId)
       VALUES (@at, @symbol, @side, @fromAsset, @toAsset, @fromQty, @toQty, @homeAsset, @homeNotional, @feeEstHome, @slippageEstHome, @lossEstHome, @orderId)`,
    ).run({
      at: row.at,
      symbol: row.symbol.toUpperCase(),
      side: String(row.side ?? '').toUpperCase(),
      fromAsset: row.fromAsset ? row.fromAsset.toUpperCase() : null,
      toAsset: row.toAsset ? row.toAsset.toUpperCase() : null,
      fromQty: row.fromQty ?? null,
      toQty: row.toQty ?? null,
      homeAsset: row.homeAsset ? row.homeAsset.toUpperCase() : null,
      homeNotional: row.homeNotional ?? null,
      feeEstHome: row.feeEstHome ?? null,
      slippageEstHome: row.slippageEstHome ?? null,
      lossEstHome: row.lossEstHome ?? null,
      orderId: row.orderId !== undefined ? String(row.orderId) : null,
    });
  });
};

const pickKlineInterval = (windowMs: number) => {
  const h = 60 * 60_000;
  const d = 24 * h;
  if (windowMs <= 3 * h) return { interval: '1m', limit: 200 };
  if (windowMs <= 12 * h) return { interval: '5m', limit: 200 };
  if (windowMs <= 2 * d) return { interval: '15m', limit: 200 };
  if (windowMs <= 8 * d) return { interval: '1h', limit: 200 };
  if (windowMs <= 33 * d) return { interval: '4h', limit: 200 };
  return { interval: '1d', limit: 200 };
};

const pickPriceFromKlines = (klines: Awaited<ReturnType<typeof getKlines>>, at: number): number | null => {
  if (!klines.length) return null;
  const inRange = klines.find((k) => k.openTime <= at && at <= k.closeTime);
  if (inRange && Number.isFinite(inRange.close) && inRange.close > 0) return inRange.close;
  const first = klines[0];
  const last = klines[klines.length - 1];
  if (first && at < first.openTime && Number.isFinite(first.open) && first.open > 0) return first.open;
  if (last && at > last.closeTime && Number.isFinite(last.close) && last.close > 0) return last.close;
  return Number.isFinite(last?.close) && (last?.close ?? 0) > 0 ? last.close : null;
};

const getPriceNowBestEffort = async (symbol: string): Promise<number | null> => {
  try {
    const snap = await get24hStats(symbol);
    return Number.isFinite(snap.price) && snap.price > 0 ? snap.price : null;
  } catch {
    return null;
  }
};

const getPriceAtBestEffort = async (symbol: string, at: number, windowMs: number): Promise<number | null> => {
  try {
    const { interval, limit } = pickKlineInterval(windowMs);
    const klines = await getKlines(symbol, interval, limit);
    return pickPriceFromKlines(klines, at);
  } catch {
    return null;
  }
};

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const pickEquitySnapshotAt = (
  active: SqliteDb,
  targetAt: number,
): { at: number; homeAsset: string; equityHome: number } | null => {
  const before = active
    .prepare(`SELECT at, homeAsset, equityHome FROM equity_snapshots WHERE at <= ${targetAt} ORDER BY at DESC LIMIT 1`)
    .get() as { at?: unknown; homeAsset?: unknown; equityHome?: unknown } | undefined;
  const after = active
    .prepare(`SELECT at, homeAsset, equityHome FROM equity_snapshots WHERE at >= ${targetAt} ORDER BY at ASC LIMIT 1`)
    .get() as { at?: unknown; homeAsset?: unknown; equityHome?: unknown } | undefined;

  const beforeAt = toNumberOrNull(before?.at);
  const afterAt = toNumberOrNull(after?.at);

  const beforeEq = toNumberOrNull(before?.equityHome);
  const afterEq = toNumberOrNull(after?.equityHome);

  const beforeHome = typeof before?.homeAsset === 'string' ? before.homeAsset.toUpperCase() : null;
  const afterHome = typeof after?.homeAsset === 'string' ? after.homeAsset.toUpperCase() : null;

  const beforeOk =
    beforeAt !== null && beforeEq !== null && beforeEq > 0 && beforeHome && beforeHome.length >= 2;
  const afterOk =
    afterAt !== null && afterEq !== null && afterEq > 0 && afterHome && afterHome.length >= 2;

  if (!beforeOk && !afterOk) return null;
  if (beforeOk && !afterOk) return { at: beforeAt!, homeAsset: beforeHome!, equityHome: beforeEq! };
  if (!beforeOk && afterOk) return { at: afterAt!, homeAsset: afterHome!, equityHome: afterEq! };

  const beforeDiff = Math.abs(targetAt - (beforeAt ?? targetAt));
  const afterDiff = Math.abs((afterAt ?? targetAt) - targetAt);
  if (afterDiff <= beforeDiff) return { at: afterAt!, homeAsset: afterHome!, equityHome: afterEq! };
  return { at: beforeAt!, homeAsset: beforeHome!, equityHome: beforeEq! };
};

export const getPnlReconcile = async (
  window?: string,
): Promise<{
  baseline: { window_start: number };
  equityStart: number | null;
  equityNow: number | null;
  equityChange: number | null;
  gridRealizedPnl: number | null;
  gridUnrealizedPnl: number | null;
  portfolioRealizedPnl: number | null;
  portfolioUnrealizedPnl: number | null;
  feesHomeTotal: number | null;
  conversionLossEstimate: number | null;
  residual: number | null;
  windowMs: number;
  startAt: number;
  nowAt: number;
  notes?: string[];
}> => {
  const normalizeNumber = (v: number | null): number | null => {
    if (v === null) return null;
    if (!Number.isFinite(v)) return null;
    if (Object.is(v, -0)) return 0;
    return Math.abs(v) < 1e-9 ? 0 : v;
  };

  const nowAt = Date.now();
  const parsed = parseWindowMs(window);
  const windowMs = parsed.windowMs;
  const startAt = nowAt - windowMs;
  const notes: string[] = [];
  if (parsed.note) notes.push(parsed.note);

  const persisted = getPersistedState();
  const active = ensureDb();
  const home = config.homeAsset.toUpperCase();

  let equityStart: number | null = null;
  let equityNow: number | null = null;
  let equityChange: number | null = null;

  if (active) {
    const startSnap = pickEquitySnapshotAt(active, startAt);
    const nowSnap = active
      .prepare(`SELECT at, homeAsset, equityHome FROM equity_snapshots ORDER BY at DESC LIMIT 1`)
      .get() as { at?: unknown; homeAsset?: unknown; equityHome?: unknown } | undefined;

    const nowHome = typeof nowSnap?.homeAsset === 'string' ? nowSnap.homeAsset.toUpperCase() : null;
    const nowEq = toNumberOrNull(nowSnap?.equityHome);
    const startHome = startSnap?.homeAsset?.toUpperCase() ?? null;
    const startEq = startSnap?.equityHome ?? null;

    if (startSnap && startEq !== null && startEq > 0 && nowHome && nowEq !== null && nowEq > 0) {
      if (startHome && startHome !== nowHome) {
        notes.push(`Equity snapshots homeAsset mismatch (${startHome} vs ${nowHome}); falling back to runtime homeAsset=${home}.`);
      } else {
        equityStart = startEq;
        equityNow = nowEq;
        equityChange = normalizeNumber(equityNow - equityStart);
      }
    }
  }

  if (equityStart === null || equityNow === null || equityChange === null) {
    const eq = persisted.meta?.equity;
    if (eq && isFiniteNumber(eq.startHome) && isFiniteNumber(eq.lastHome) && eq.startHome > 0 && eq.lastHome > 0) {
      const age = isFiniteNumber(eq.startAt) ? nowAt - eq.startAt : null;
      if (age !== null && age < windowMs + 60_000) {
        equityStart = eq.startHome;
        equityNow = eq.lastHome;
        equityChange = normalizeNumber(equityNow - equityStart);
        notes.push('Equity history unavailable; using in-memory daily baseline.');
      } else {
        notes.push('Equity history unavailable for requested window; enable SQLite to persist equity snapshots.');
      }
    } else {
      notes.push('Equity telemetry unavailable (missing API keys or balances).');
    }
  }

  if (!active) {
    return {
      baseline: { window_start: startAt },
      equityStart,
      equityNow,
      equityChange,
      gridRealizedPnl: null,
      gridUnrealizedPnl: null,
      portfolioRealizedPnl: null,
      portfolioUnrealizedPnl: null,
      feesHomeTotal: null,
      conversionLossEstimate: null,
      residual: equityChange !== null ? equityChange : null,
      windowMs,
      startAt,
      nowAt,
      notes: notes.length ? notes : undefined,
    };
  }

  const fillTrades =
    config.tradeVenue === 'spot'
      ? (active
          .prepare(
            `SELECT at, symbol, module, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feesHome, orderId, tradeId
             FROM trades
             WHERE event='FILL'
             ORDER BY at ASC`,
          )
          .all() as Array<Record<string, unknown>>)
      : [];

  let symbolInfo: Awaited<ReturnType<typeof fetchTradableSymbols>> | null = null;
  try {
    symbolInfo = await fetchTradableSymbols();
  } catch {
    symbolInfo = null;
  }

  const usingFillTrades = fillTrades.length > 0;

  let grid: { realizedDelta: number | null; unrealizedDelta: number | null; feesDelta: number | null; notes?: string[] };
  let portfolio: { realizedDelta: number | null; unrealizedDelta: number | null; feesDelta: number | null; notes?: string[] };

  const priceStartBySymbol = new Map<string, number>();
  const priceNowBySymbol = new Map<string, number>();

  const quoteToHomeStart = new Map<string, number>();
  const quoteToHomeNow = new Map<string, number>();

  const rateCache = new Map<string, number | null>();

  const assetToAssetRateAt = async (fromAsset: string, toAsset: string, at: number): Promise<number | null> => {
    const from = fromAsset.toUpperCase();
    const to = toAsset.toUpperCase();
    if (from === to) return 1;
    if (!symbolInfo) return null;

    const bucket = at === startAt ? 'start' : at === nowAt ? 'now' : String(at);
    const cacheKey = `${from}:${to}:${bucket}`;
    if (rateCache.has(cacheKey)) return rateCache.get(cacheKey) ?? null;

    const direct = symbolInfo.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
    );
    const inverse = symbolInfo.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
    );

    let out: number | null = null;
    if (direct) {
      const p = at === nowAt ? await getPriceNowBestEffort(direct.symbol) : await getPriceAtBestEffort(direct.symbol, at, windowMs);
      out = p && p > 0 ? p : null;
    } else if (inverse) {
      const p = at === nowAt ? await getPriceNowBestEffort(inverse.symbol) : await getPriceAtBestEffort(inverse.symbol, at, windowMs);
      out = p && p > 0 ? 1 / p : null;
    }

    rateCache.set(cacheKey, out);
    return out;
  };

  const assetToHomeRateAt = async (asset: string, at: number): Promise<number | null> => {
    const upper = asset.toUpperCase();
    if (upper === home) return 1;
    const direct = await assetToAssetRateAt(upper, home, at);
    if (direct) return direct;

    const mids = ['USDC', 'USDT', 'BTC', 'ETH', 'BNB'];
    for (const mid of mids) {
      const midUp = mid.toUpperCase();
      if (midUp === upper || midUp === home) continue;
      const leg1 = await assetToAssetRateAt(upper, midUp, at);
      if (!leg1) continue;
      const leg2 = await assetToAssetRateAt(midUp, home, at);
      if (!leg2) continue;
      return leg1 * leg2;
    }
    return null;
  };

  if (usingFillTrades) {
    const symbols = new Set<string>();
    for (const row of fillTrades) {
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (sym) symbols.add(sym);
    }

    for (const sym of symbols) {
      const [pStart, pNow] = await Promise.all([getPriceAtBestEffort(sym, startAt, windowMs), getPriceNowBestEffort(sym)]);
      if (pStart !== null) priceStartBySymbol.set(sym, pStart);
      if (pNow !== null) priceNowBySymbol.set(sym, pNow);
    }

    const quoteAssetBySymbol = new Map<string, string>();
    if (symbolInfo) {
      for (const s of symbolInfo) {
        if (!s?.symbol || !s.quoteAsset) continue;
        quoteAssetBySymbol.set(s.symbol.toUpperCase(), s.quoteAsset.toUpperCase());
      }
    }

    const quoteAssets = new Set<string>();
    for (const row of fillTrades) {
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (!sym) continue;
      const qa = typeof row.quoteAsset === 'string' ? row.quoteAsset.toUpperCase() : quoteAssetBySymbol.get(sym) ?? null;
      if (!qa) continue;
      row.quoteAsset = qa;
      quoteAssets.add(qa);
    }

    for (const asset of quoteAssets) {
      if (asset === home) {
        quoteToHomeStart.set(asset, 1);
        quoteToHomeNow.set(asset, 1);
        continue;
      }
      const [rStart, rNow] = await Promise.all([assetToHomeRateAt(asset, startAt), assetToHomeRateAt(asset, nowAt)]);
      if (rStart !== null) quoteToHomeStart.set(asset, rStart);
      if (rNow !== null) quoteToHomeNow.set(asset, rNow);
    }

    const gridRows = fillTrades.filter((r) => String(r.module ?? '').toLowerCase() === 'grid');
    const portfolioRows = fillTrades.filter((r) => String(r.module ?? '').toLowerCase() !== 'grid');

    const gridOut = computeFillPnlDeltasBySymbol({
      rows: gridRows,
      startAt,
      priceStartBySymbol,
      priceNowBySymbol,
      quoteToHomeStart,
      quoteToHomeNow,
      homeAsset: home,
    });
    grid = { realizedDelta: gridOut.realizedDelta, unrealizedDelta: gridOut.unrealizedDelta, feesDelta: gridOut.feesDelta, notes: gridOut.notes };

    const portfolioOut = computeFillPnlDeltasBySymbol({
      rows: portfolioRows,
      startAt,
      priceStartBySymbol,
      priceNowBySymbol,
      quoteToHomeStart,
      quoteToHomeNow,
      homeAsset: home,
    });
    portfolio = { realizedDelta: portfolioOut.realizedDelta, unrealizedDelta: portfolioOut.unrealizedDelta, feesDelta: portfolioOut.feesDelta, notes: portfolioOut.notes };
  } else {
    const gridFills = active
      .prepare(
        `SELECT at, symbol, side, executedQty, notional, feeEst, price, orderId
         FROM grid_fills
         ORDER BY at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    const trades = active
      .prepare(
        `SELECT at, symbol, positionKey, event, side, qty, avgPrice, quoteAsset, homeAsset, feesHome, pnlHome, netPnlHome, orderId
         FROM trades
         ORDER BY at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    const symbols = new Set<string>();
    for (const row of gridFills) {
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (sym) symbols.add(sym);
    }
    for (const row of trades) {
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (sym) symbols.add(sym);
    }

    for (const sym of symbols) {
      const [pStart, pNow] = await Promise.all([getPriceAtBestEffort(sym, startAt, windowMs), getPriceNowBestEffort(sym)]);
      if (pStart !== null) priceStartBySymbol.set(sym, pStart);
      if (pNow !== null) priceNowBySymbol.set(sym, pNow);
    }

    const quoteAssets = new Set<string>();
    for (const row of trades) {
      const qa = typeof row.quoteAsset === 'string' ? row.quoteAsset.toUpperCase() : null;
      if (qa) quoteAssets.add(qa);
    }

    for (const asset of quoteAssets) {
      if (asset === home) {
        quoteToHomeStart.set(asset, 1);
        quoteToHomeNow.set(asset, 1);
        continue;
      }
      const [rStart, rNow] = await Promise.all([assetToHomeRateAt(asset, startAt), assetToHomeRateAt(asset, nowAt)]);
      if (rStart !== null) quoteToHomeStart.set(asset, rStart);
      if (rNow !== null) quoteToHomeNow.set(asset, rNow);
    }

    grid = computeGridPnlDeltas({
      rows: gridFills,
      startAt,
      priceStartBySymbol,
      priceNowBySymbol,
    });

    portfolio = computePortfolioPnlDeltas({
      rows: trades,
      startAt,
      priceStartBySymbol,
      priceNowBySymbol,
      quoteToHomeStart,
      quoteToHomeNow,
      homeAsset: home,
    });
  }

  notes.push(...(grid.notes ?? []));
  notes.push(...(portfolio.notes ?? []));

  let conversionLossEstimate: number | null = null;
  if (config.conversionEnabled) {
    try {
      const loss = Number(
        active
          .prepare(
            `SELECT COALESCE(SUM(lossEstHome), 0) as s FROM conversion_events WHERE at > ${startAt} AND at <= ${nowAt}`,
          )
          .get()?.s ?? 0,
      );
      conversionLossEstimate = normalizeNumber(-Math.max(0, loss));
    } catch {
      conversionLossEstimate = null;
    }
  }

  const feesHomeTotal = normalizeNumber(
    grid.feesDelta !== null || portfolio.feesDelta !== null
      ? -((grid.feesDelta ?? 0) + (portfolio.feesDelta ?? 0))
      : null,
  );

  const gridRealizedPnl = normalizeNumber(grid.realizedDelta);
  const gridUnrealizedPnl = normalizeNumber(grid.unrealizedDelta);
  const portfolioRealizedPnl = normalizeNumber(portfolio.realizedDelta);
  const portfolioUnrealizedPnl = normalizeNumber(portfolio.unrealizedDelta);

  const components =
    (gridRealizedPnl ?? 0) +
    (gridUnrealizedPnl ?? 0) +
    (portfolioRealizedPnl ?? 0) +
    (portfolioUnrealizedPnl ?? 0) +
    (feesHomeTotal ?? 0) +
    (conversionLossEstimate ?? 0);

  const residual = equityChange !== null ? normalizeNumber(equityChange - components) : null;

  return {
    baseline: { window_start: startAt },
    equityStart,
    equityNow,
    equityChange: normalizeNumber(equityChange),
    gridRealizedPnl,
    gridUnrealizedPnl,
    portfolioRealizedPnl,
    portfolioUnrealizedPnl,
    feesHomeTotal,
    conversionLossEstimate,
    residual,
    windowMs,
    startAt,
    nowAt,
    notes: notes.length ? Array.from(new Set(notes)).slice(0, 12) : undefined,
  };
};

export const getPnlExplain = async (
  window?: string,
): Promise<{
  baseline: { window_start: number };
  windowMs: number;
  startAt: number;
  nowAt: number;
  totals: {
    equityStart: number | null;
    equityNow: number | null;
    equityChange: number | null;
    gridRealizedPnl: number | null;
    gridUnrealizedPnl: number | null;
    portfolioRealizedPnl: number | null;
    portfolioUnrealizedPnl: number | null;
    feesHomeTotal: number | null;
    conversionLossEstimate: number | null;
    residual: number | null;
  };
  topSymbols: Array<{
    symbol: string;
    contribution: number;
    realized: number;
    unrealized: number;
    fees: number;
  }>;
  biggestFees: Array<{
    symbol: string;
    feesHome: number;
  }>;
  why: string[];
  notes?: string[];
}> => {
  const reconcile = await getPnlReconcile(window);
  const startAt = reconcile.startAt;
  const nowAt = reconcile.nowAt;
  const windowMs = reconcile.windowMs;

  const totals = {
    equityStart: reconcile.equityStart,
    equityNow: reconcile.equityNow,
    equityChange: reconcile.equityChange,
    gridRealizedPnl: reconcile.gridRealizedPnl,
    gridUnrealizedPnl: reconcile.gridUnrealizedPnl,
    portfolioRealizedPnl: reconcile.portfolioRealizedPnl,
    portfolioUnrealizedPnl: reconcile.portfolioUnrealizedPnl,
    feesHomeTotal: reconcile.feesHomeTotal,
    conversionLossEstimate: reconcile.conversionLossEstimate,
    residual: reconcile.residual,
  };

  const notes: string[] = [];
  if (reconcile.notes?.length) notes.push(...reconcile.notes);

  const active = ensureDb();
  if (!active) {
    return {
      baseline: reconcile.baseline,
      windowMs,
      startAt,
      nowAt,
      totals,
      topSymbols: [],
      biggestFees: [],
      why: ['Enable PERSIST_TO_SQLITE=true to persist fills and explain PnL.'],
      notes: notes.length ? Array.from(new Set(notes)).slice(0, 12) : undefined,
    };
  }

  if (config.tradeVenue !== 'spot') {
    return {
      baseline: reconcile.baseline,
      windowMs,
      startAt,
      nowAt,
      totals,
      topSymbols: [],
      biggestFees: [],
      why: ['PnL explain is currently best-effort for spot fills.'],
      notes: notes.length ? Array.from(new Set(notes)).slice(0, 12) : undefined,
    };
  }

  const fillTrades = active
    .prepare(
      `SELECT at, symbol, module, side, qty, avgPrice, price, notional, quoteAsset, homeAsset, feesHome, orderId, tradeId
       FROM trades
       WHERE event='FILL'
       ORDER BY at ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  if (!fillTrades.length) {
    return {
      baseline: reconcile.baseline,
      windowMs,
      startAt,
      nowAt,
      totals,
      topSymbols: [],
      biggestFees: [],
      why: ['No persisted fills found yet (trades WHERE event=FILL).'],
      notes: notes.length ? Array.from(new Set(notes)).slice(0, 12) : undefined,
    };
  }

  const home = config.homeAsset.toUpperCase();
  const symbols = new Set<string>();
  for (const row of fillTrades) {
    const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    if (sym) symbols.add(sym);
  }

  const priceStartBySymbol = new Map<string, number>();
  const priceNowBySymbol = new Map<string, number>();
  for (const sym of symbols) {
    const [pStart, pNow] = await Promise.all([getPriceAtBestEffort(sym, startAt, windowMs), getPriceNowBestEffort(sym)]);
    if (pStart !== null) priceStartBySymbol.set(sym, pStart);
    if (pNow !== null) priceNowBySymbol.set(sym, pNow);
  }

  let symbolInfo: Awaited<ReturnType<typeof fetchTradableSymbols>> | null = null;
  try {
    symbolInfo = await fetchTradableSymbols();
  } catch {
    symbolInfo = null;
  }

  const quoteAssetBySymbol = new Map<string, string>();
  if (symbolInfo) {
    for (const s of symbolInfo) {
      if (!s?.symbol || !s.quoteAsset) continue;
      quoteAssetBySymbol.set(s.symbol.toUpperCase(), s.quoteAsset.toUpperCase());
    }
  }

  const quoteAssets = new Set<string>();
  for (const row of fillTrades) {
    const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    if (!sym) continue;
    const qa = typeof row.quoteAsset === 'string' ? row.quoteAsset.toUpperCase() : quoteAssetBySymbol.get(sym) ?? null;
    if (!qa) continue;
    row.quoteAsset = qa;
    quoteAssets.add(qa);
  }

  const quoteToHomeStart = new Map<string, number>();
  const quoteToHomeNow = new Map<string, number>();

  const rateCache = new Map<string, number | null>();

  const assetToAssetRateAt = async (fromAsset: string, toAsset: string, at: number): Promise<number | null> => {
    const from = fromAsset.toUpperCase();
    const to = toAsset.toUpperCase();
    if (from === to) return 1;
    if (!symbolInfo) return null;

    const bucket = at === startAt ? 'start' : at === nowAt ? 'now' : String(at);
    const cacheKey = `${from}:${to}:${bucket}`;
    if (rateCache.has(cacheKey)) return rateCache.get(cacheKey) ?? null;

    const direct = symbolInfo.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === from && s.quoteAsset.toUpperCase() === to,
    );
    const inverse = symbolInfo.find(
      (s) => s.status === 'TRADING' && s.baseAsset.toUpperCase() === to && s.quoteAsset.toUpperCase() === from,
    );

    let out: number | null = null;
    if (direct) {
      const p = at === nowAt ? await getPriceNowBestEffort(direct.symbol) : await getPriceAtBestEffort(direct.symbol, at, windowMs);
      out = p && p > 0 ? p : null;
    } else if (inverse) {
      const p = at === nowAt ? await getPriceNowBestEffort(inverse.symbol) : await getPriceAtBestEffort(inverse.symbol, at, windowMs);
      out = p && p > 0 ? 1 / p : null;
    }

    rateCache.set(cacheKey, out);
    return out;
  };

  const assetToHomeRateAt = async (asset: string, at: number): Promise<number | null> => {
    const upper = asset.toUpperCase();
    if (upper === home) return 1;
    const direct = await assetToAssetRateAt(upper, home, at);
    if (direct) return direct;

    const mids = ['USDC', 'USDT', 'BTC', 'ETH', 'BNB'];
    for (const mid of mids) {
      const midUp = mid.toUpperCase();
      if (midUp === upper || midUp === home) continue;
      const leg1 = await assetToAssetRateAt(upper, midUp, at);
      if (!leg1) continue;
      const leg2 = await assetToAssetRateAt(midUp, home, at);
      if (!leg2) continue;
      return leg1 * leg2;
    }
    return null;
  };

  for (const asset of quoteAssets) {
    if (asset === home) {
      quoteToHomeStart.set(asset, 1);
      quoteToHomeNow.set(asset, 1);
      continue;
    }
    const [rStart, rNow] = await Promise.all([assetToHomeRateAt(asset, startAt), assetToHomeRateAt(asset, nowAt)]);
    if (rStart !== null) quoteToHomeStart.set(asset, rStart);
    if (rNow !== null) quoteToHomeNow.set(asset, rNow);
  }

  const gridRows = fillTrades.filter((r) => String(r.module ?? '').toLowerCase() === 'grid');
  const portfolioRows = fillTrades.filter((r) => String(r.module ?? '').toLowerCase() !== 'grid');

  const gridOut = computeFillPnlDeltasBySymbol({
    rows: gridRows,
    startAt,
    priceStartBySymbol,
    priceNowBySymbol,
    quoteToHomeStart,
    quoteToHomeNow,
    homeAsset: home,
  });
  const portfolioOut = computeFillPnlDeltasBySymbol({
    rows: portfolioRows,
    startAt,
    priceStartBySymbol,
    priceNowBySymbol,
    quoteToHomeStart,
    quoteToHomeNow,
    homeAsset: home,
  });
  if (gridOut.notes?.length) notes.push(...gridOut.notes);
  if (portfolioOut.notes?.length) notes.push(...portfolioOut.notes);

  const combined = new Map<string, { realized: number; unrealized: number; fees: number }>();
  const add = (symbol: string, d: { realizedDelta: number; unrealizedDelta: number; feesDelta: number }) => {
    const prev = combined.get(symbol) ?? { realized: 0, unrealized: 0, fees: 0 };
    combined.set(symbol, {
      realized: prev.realized + d.realizedDelta,
      unrealized: prev.unrealized + d.unrealizedDelta,
      fees: prev.fees + d.feesDelta,
    });
  };

  for (const row of gridOut.bySymbol) add(row.symbol, row);
  for (const row of portfolioOut.bySymbol) add(row.symbol, row);

  const topSymbols = Array.from(combined.entries())
    .map(([symbol, v]) => ({
      symbol,
      realized: v.realized,
      unrealized: v.unrealized,
      fees: -v.fees,
      contribution: v.realized + v.unrealized - v.fees,
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.symbol.localeCompare(b.symbol))
    .slice(0, 8);

  const biggestFees = Array.from(combined.entries())
    .map(([symbol, v]) => ({ symbol, feesHome: v.fees }))
    .filter((r) => Number.isFinite(r.feesHome) && r.feesHome > 0)
    .sort((a, b) => b.feesHome - a.feesHome || a.symbol.localeCompare(b.symbol))
    .slice(0, 8);

  const why: string[] = [];
  if (totals.residual !== null && totals.equityChange !== null && Math.abs(totals.residual) > Math.max(0.5, Math.abs(totals.equityChange) * 0.25)) {
    why.push('Large residual vs components: likely missing fills, deposits/withdrawals, or pricing gaps.');
  }

  const persisted = getPersistedState();
  const windowNetQtyBySymbol = new Map<string, number>();
  for (const row of fillTrades) {
    const at = toNumberOrNull((row as { at?: unknown }).at);
    const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
    if (!sym || at === null) continue;
    if (at <= startAt || at > nowAt) continue;
    const side = String(row.side ?? '').toUpperCase();
    const qty = toNumberOrNull((row as { qty?: unknown }).qty) ?? 0;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const delta = side === 'BUY' ? qty : side === 'SELL' ? -qty : 0;
    if (!delta) continue;
    windowNetQtyBySymbol.set(sym, (windowNetQtyBySymbol.get(sym) ?? 0) + delta);
  }

  for (const item of topSymbols.slice(0, 5)) {
    const netQty = windowNetQtyBySymbol.get(item.symbol) ?? 0;
    const grid = persisted.grids?.[item.symbol.toUpperCase()];
    const gridRunning = grid?.status === 'running';
    const gridBuysActive = gridRunning && grid?.buyPaused !== true;
    if (item.unrealized < 0 && netQty > 0) {
      why.push(`Inventory drawdown in ${item.symbol}${gridBuysActive ? ' while grid buys active' : ''}.`);
    } else if (item.realized < 0) {
      why.push(`Realized losses in ${item.symbol} from sells during the window.`);
    } else if (item.fees < 0 && Math.abs(item.fees) > Math.max(0.1, Math.abs(item.contribution) * 0.5)) {
      why.push(`Fees were a large drag for ${item.symbol} during the window.`);
    }
  }

  if (!why.length) why.push('PnL drivers were small or data was insufficient to attribute confidently.');

  return {
    baseline: reconcile.baseline,
    windowMs,
    startAt,
    nowAt,
    totals,
    topSymbols,
    biggestFees,
    why: Array.from(new Set(why)).slice(0, 8),
    notes: notes.length ? Array.from(new Set(notes)).slice(0, 12) : undefined,
  };
};

export const getPerformanceStats = (): {
  enabled: boolean;
  path?: string;
  totalTrades: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number | null;
  totalFees: number;
  netPnlByDay: Array<{ day: string; netPnlHome: number; feesHome: number }>;
  lastErrorAt?: number | null;
} => {
  if (!config.persistToSqlite) {
    return {
      enabled: false,
      totalTrades: 0,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      maxDrawdown: null,
      totalFees: 0,
      netPnlByDay: [],
    };
  }

  const active = ensureDb();
  if (!active) {
    return {
      enabled: false,
      path: config.sqlitePath,
      totalTrades: 0,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      maxDrawdown: null,
      totalFees: 0,
      netPnlByDay: [],
      lastErrorAt: lastOpenErrorAt,
    };
  }

  try {
    const totalTrades = Number(
      active.prepare(`SELECT COUNT(*) as n FROM trades WHERE event='CLOSE'`).get()?.n ?? 0,
    );
    const wins = Number(
      active.prepare(`SELECT COUNT(*) as n FROM trades WHERE event='CLOSE' AND COALESCE(netPnlHome, pnlHome) > 0`).get()
        ?.n ?? 0,
    );
    const totalFees = Number(active.prepare(`SELECT COALESCE(SUM(feesHome), 0) as s FROM trades`).get()?.s ?? 0);

    const avgWin = active
      .prepare(
        `SELECT AVG(COALESCE(netPnlHome, pnlHome)) as v FROM trades WHERE event='CLOSE' AND COALESCE(netPnlHome, pnlHome) > 0`,
      )
      .get()?.v as number | null | undefined;
    const avgLoss = active
      .prepare(
        `SELECT AVG(COALESCE(netPnlHome, pnlHome)) as v FROM trades WHERE event='CLOSE' AND COALESCE(netPnlHome, pnlHome) < 0`,
      )
      .get()?.v as number | null | undefined;

    const dailyNet = active
      .prepare(
        `SELECT
           substr(datetime(at/1000,'unixepoch'), 1, 10) as day,
           COALESCE(SUM(netPnlHome), COALESCE(SUM(pnlHome), 0) - COALESCE(SUM(feesHome), 0)) as netPnlHome
         FROM trades
         WHERE event='CLOSE'
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all() as Array<{ day: string; netPnlHome: number }>;

    const dailyFees = active
      .prepare(
        `SELECT
           substr(datetime(at/1000,'unixepoch'), 1, 10) as day,
           COALESCE(SUM(feesHome), 0) as feesHome
         FROM trades
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all() as Array<{ day: string; feesHome: number }>;

    const feesByDay = new Map(dailyFees.map((r) => [String(r.day), Number(r.feesHome ?? 0)]));

    let peak = 0;
    let curve = 0;
    let maxDrawdown = 0;
    for (const row of dailyNet) {
      curve += Number(row.netPnlHome ?? 0);
      peak = Math.max(peak, curve);
      maxDrawdown = Math.max(maxDrawdown, peak - curve);
    }

    return {
      enabled: true,
      path: config.sqlitePath,
      totalTrades,
      winRate: totalTrades > 0 ? wins / totalTrades : null,
      avgWin: avgWin ?? null,
      avgLoss: avgLoss ?? null,
      maxDrawdown: dailyNet.length > 0 ? maxDrawdown : null,
      totalFees,
      netPnlByDay: dailyNet.map((r) => ({
        day: String(r.day),
        netPnlHome: Number(r.netPnlHome ?? 0),
        feesHome: feesByDay.get(String(r.day)) ?? 0,
      })),
      lastErrorAt: lastOpenErrorAt,
    };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'SQLite: performance query failed');
    return {
      enabled: false,
      path: config.sqlitePath,
      totalTrades: 0,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      maxDrawdown: null,
      totalFees: 0,
      netPnlByDay: [],
      lastErrorAt: lastOpenErrorAt,
    };
  }
};

export const getDbHealth = (): {
  persistToSqlite: boolean;
  sqliteFile?: string;
  counts: { market_features: number; decisions: number; trades: number };
  lastWriteAt: number | null;
  lastError?: string;
} => {
  const sqliteFile = config.sqlitePath ? path.basename(config.sqlitePath) : undefined;
  const base = {
    persistToSqlite: !!config.persistToSqlite,
    sqliteFile,
    counts: { market_features: 0, decisions: 0, trades: 0 },
    lastWriteAt,
  };

  if (!config.persistToSqlite) return base;

  const active = ensureDb();
  if (!active) {
    const lastError = lastWriteError ?? lastOpenError ?? (lastOpenErrorAt ? 'SQLite unavailable' : null);
    return lastError ? { ...base, lastError } : base;
  }

  try {
    const market_features = Number(active.prepare(`SELECT COUNT(*) as n FROM market_features`).get()?.n ?? 0);
    const decisions = Number(active.prepare(`SELECT COUNT(*) as n FROM decisions`).get()?.n ?? 0);
    const trades = Number(active.prepare(`SELECT COUNT(*) as n FROM trades`).get()?.n ?? 0);
    const lastError = lastWriteError ?? lastOpenError ?? null;
    return lastError
      ? { ...base, counts: { market_features, decisions, trades }, lastError }
      : { ...base, counts: { market_features, decisions, trades } };
  } catch (error) {
    const lastError = (error instanceof Error ? error.message.slice(0, 180) : 'SQLite stats failed') ?? 'SQLite stats failed';
    return { ...base, lastError };
  }
};
