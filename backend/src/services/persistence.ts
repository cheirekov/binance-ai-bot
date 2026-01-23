import fs from 'fs';
import path from 'path';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { PersistedPayload, StrategyResponsePayload } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';

let singleton: PersistedPayload | null = null;

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export const loadState = (): PersistedPayload => {
  try {
    const raw = fs.readFileSync(config.persistencePath, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedPayload;
    return {
      strategies: parsed.strategies ?? {},
      lastTrades: parsed.lastTrades ?? {},
      positions: parsed.positions ?? {},
      meta: parsed.meta ?? {},
    };
  } catch {
    return { strategies: {}, lastTrades: {}, positions: {}, meta: {} };
  }
};

export const getPersistedState = (): PersistedPayload => {
  if (!singleton) singleton = loadState();
  return singleton;
};

export const saveState = (state: PersistedPayload) => {
  try {
    ensureDir(config.persistencePath);
    fs.writeFileSync(config.persistencePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Failed to persist state');
  }
};

export const persistStrategy = (
  persisted: PersistedPayload,
  symbol: string,
  snapshot: StrategyResponsePayload,
) => {
  persisted.strategies[symbol] = snapshot;
  saveState(persisted);
};

export const persistLastTrade = (persisted: PersistedPayload, key: string, timestamp: number) => {
  persisted.lastTrades[key] = timestamp;
  saveState(persisted);
};

export const persistPosition = (
  persisted: PersistedPayload,
  key: string,
  position: PersistedPayload['positions'][string] | null,
) => {
  if (position) {
    persisted.positions[key] = position;
  } else {
    delete persisted.positions[key];
  }
  saveState(persisted);
};

export const persistMeta = (persisted: PersistedPayload, meta: PersistedPayload['meta']) => {
  persisted.meta = { ...(persisted.meta ?? {}), ...(meta ?? {}) };
  saveState(persisted);
};
