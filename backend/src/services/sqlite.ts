import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { errorToLogObject } from '../utils/errors.js';

type SqliteDb = {
  pragma: (value: string) => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (params?: Record<string, unknown>) => void;
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
      positionKey TEXT,
      event TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      avgPrice REAL NOT NULL,
      quoteAsset TEXT,
      homeAsset TEXT,
      feesHome REAL,
      pnlHome REAL,
      netPnlHome REAL,
      orderId TEXT
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
  `);
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
  positionKey?: string;
  event: 'OPEN' | 'CLOSE';
  side: string;
  qty: number;
  avgPrice: number;
  quoteAsset?: string;
  homeAsset?: string;
  feesHome?: number;
  pnlHome?: number;
  netPnlHome?: number;
  orderId?: string | number;
}) => {
  enqueueWrite((db) => {
    db.prepare(
      `INSERT INTO trades (at, symbol, positionKey, event, side, qty, avgPrice, quoteAsset, homeAsset, feesHome, pnlHome, netPnlHome, orderId)
       VALUES (@at, @symbol, @positionKey, @event, @side, @qty, @avgPrice, @quoteAsset, @homeAsset, @feesHome, @pnlHome, @netPnlHome, @orderId)`,
    ).run({
      ...row,
      symbol: row.symbol.toUpperCase(),
      orderId: row.orderId !== undefined ? String(row.orderId) : null,
    });
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
