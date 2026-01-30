import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PersistedPayload } from '../types.js';
import { errorToLogObject } from '../utils/errors.js';
import { getPersistedState, persistMeta } from './persistence.js';
import { persistAutoBlacklistEvent } from './sqlite.js';

const persisted = getPersistedState();

const isSymbolKey = (value: string) => /^[A-Z0-9]{2,30}$/.test(value.toUpperCase());

export type SymbolBlockInfo =
  | { blocked: false }
  | {
      blocked: true;
      code: 'invalid' | 'not_in_universe' | 'denylist' | 'account_blacklist' | 'auto_blacklist';
      reason: string;
      bannedUntil?: number;
      ttlMinutes?: number;
      source?: string;
    };

export const pruneExpiredAutoBlacklist = (now = Date.now()) => {
  try {
    const current = persisted.meta?.autoBlacklist ?? {};
    const entries = Object.entries(current);
    if (entries.length === 0) return { ok: true as const, pruned: 0 };

    let pruned = 0;
    const next: NonNullable<NonNullable<PersistedPayload['meta']>['autoBlacklist']> = {};

    for (const [key, entry] of entries) {
      const symbol = key.toUpperCase();
      if (!isSymbolKey(symbol)) {
        pruned += 1;
        continue;
      }
      const bannedUntil = typeof entry?.bannedUntil === 'number' ? entry.bannedUntil : 0;
      if (!Number.isFinite(bannedUntil) || bannedUntil <= now) {
        pruned += 1;
        continue;
      }
      next[symbol] = {
        at: typeof entry?.at === 'number' ? entry.at : now,
        bannedUntil,
        ttlMinutes: typeof entry?.ttlMinutes === 'number' ? entry.ttlMinutes : config.autoBlacklistTtlMinutes,
        reason: typeof entry?.reason === 'string' ? entry.reason : 'auto_blacklist',
        source: entry?.source,
        triggers: Array.isArray(entry?.triggers) ? entry.triggers : undefined,
      };
    }

    if (pruned > 0) {
      persistMeta(persisted, { autoBlacklist: next });
    }
    return { ok: true as const, pruned };
  } catch (error) {
    logger.warn({ err: errorToLogObject(error) }, 'Failed to prune auto-blacklist');
    return { ok: false as const, pruned: 0, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

export const getAutoBlacklist = () => {
  pruneExpiredAutoBlacklist();
  return persisted.meta?.autoBlacklist ?? {};
};

const deriveQuoteAsset = (symbol: string): string => {
  const candidates = [...config.quoteAssets, 'BTC', 'BNB', 'ETH'].map((q) => q.toUpperCase());
  const sym = symbol.toUpperCase();
  const match = candidates.find((q) => sym.endsWith(q));
  return match ?? sym.slice(-3);
};

export const isSymbolViewAllowed = (symbolInput: string): boolean => {
  const sym = (symbolInput ?? '').toUpperCase();
  if (!sym || !isSymbolKey(sym)) return false;

  // Always allow viewing symbols that already exist in bot state.
  if (persisted.grids?.[sym]) return true;
  if (Object.values(persisted.positions ?? {}).some((p) => (p?.symbol ?? '').toUpperCase() === sym)) return true;
  if (Object.keys(persisted.strategies ?? {}).some((s) => s.toUpperCase() === sym)) return true;
  if (Object.keys(persisted.lastTrades ?? {}).some((k) => (k.split(':')[0] ?? '').toUpperCase() === sym)) return true;

  // If the UI knows about a symbol (e.g. ranked candidates), allow viewing it.
  if ((persisted.meta?.rankedCandidates ?? []).some((c) => (c.symbol ?? '').toUpperCase() === sym)) return true;
  if ((persisted.meta?.rankedGridCandidates ?? []).some((c) => (c.symbol ?? '').toUpperCase() === sym)) return true;

  // Default to true: view list is already bounded elsewhere (constructed from known symbols).
  return true;
};

export const isSymbolTradeAllowed = (symbolInput: string, now = Date.now()): boolean => !getSymbolBlockInfo(symbolInput, now).blocked;

export const getSymbolBlockInfo = (symbolInput: string, now = Date.now()): SymbolBlockInfo => {
  const sym = (symbolInput ?? '').toUpperCase();
  if (!sym || !isSymbolKey(sym)) return { blocked: true, code: 'invalid', reason: 'Invalid symbol key' };

  // Explicit universe (hard allow-list)
  if (config.tradeUniverse.length > 0 && !config.tradeUniverse.map((s) => s.toUpperCase()).includes(sym)) {
    return {
      blocked: true,
      code: 'not_in_universe',
      reason: 'Not in TRADE_UNIVERSE',
      source: 'TRADE_UNIVERSE',
    };
  }

  // Always excluded
  if (config.tradeDenylist.map((s) => s.toUpperCase()).includes(sym)) {
    return { blocked: true, code: 'denylist', reason: 'Blocked by TRADE_DENYLIST', source: 'TRADE_DENYLIST' };
  }

  // If universe is auto-discovered (TRADE_UNIVERSE empty), gate trading by quote asset.
  if (config.tradeUniverse.length === 0) {
    const quote = deriveQuoteAsset(sym);
    if (!config.quoteAssets.map((q) => q.toUpperCase()).includes(quote)) {
      return { blocked: true, code: 'not_in_universe', reason: `Quote asset ${quote} not in QUOTE_ASSETS`, source: 'QUOTE_ASSETS' };
    }
  }

  const account = persisted.meta?.accountBlacklist?.[sym];
  if (account) {
    return {
      blocked: true,
      code: 'account_blacklist',
      reason: account.reason ?? 'Blocked by account blacklist',
      source: 'account_blacklist',
    };
  }

  const auto = persisted.meta?.autoBlacklist?.[sym];
  if (config.autoBlacklistEnabled && auto && typeof auto.bannedUntil === 'number' && auto.bannedUntil > now) {
    return {
      blocked: true,
      code: 'auto_blacklist',
      reason: auto.reason ?? 'Auto-blacklisted',
      bannedUntil: auto.bannedUntil,
      ttlMinutes: auto.ttlMinutes,
      source: auto.source ?? 'auto_blacklist',
    };
  }

  return { blocked: false };
};

export const listBlockedSymbols = (): Array<{ symbol: string; info: Exclude<SymbolBlockInfo, { blocked: false }> }> => {
  const now = Date.now();
  pruneExpiredAutoBlacklist(now);
  const out: Array<{ symbol: string; info: Exclude<SymbolBlockInfo, { blocked: false }> }> = [];

  const push = (symbol: string, info: Exclude<SymbolBlockInfo, { blocked: false }>) => {
    out.push({ symbol: symbol.toUpperCase(), info });
  };

  for (const s of config.tradeDenylist ?? []) {
    const sym = s.toUpperCase();
    if (!isSymbolKey(sym)) continue;
    push(sym, { blocked: true, code: 'denylist', reason: 'Blocked by TRADE_DENYLIST', source: 'TRADE_DENYLIST' });
  }

  for (const [sym, entry] of Object.entries(persisted.meta?.accountBlacklist ?? {})) {
    const s = sym.toUpperCase();
    if (!isSymbolKey(s)) continue;
    push(s, { blocked: true, code: 'account_blacklist', reason: entry.reason ?? 'Blocked by account blacklist', source: 'account_blacklist' });
  }

  for (const [sym, entry] of Object.entries(persisted.meta?.autoBlacklist ?? {})) {
    const s = sym.toUpperCase();
    if (!isSymbolKey(s)) continue;
    const until = typeof entry?.bannedUntil === 'number' ? entry.bannedUntil : 0;
    if (!Number.isFinite(until) || until <= now) continue;
    push(s, {
      blocked: true,
      code: 'auto_blacklist',
      reason: entry.reason ?? 'Auto-blacklisted',
      bannedUntil: until,
      ttlMinutes: entry.ttlMinutes,
      source: entry.source ?? 'auto_blacklist',
    });
  }

  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
};

export const addAutoBlacklistSymbol = (params: {
  symbol: string;
  ttlMinutes?: number;
  reason: string;
  source: 'ai-coach' | 'trigger' | 'manual';
  triggers?: string[];
}): { ok: true; entry: NonNullable<NonNullable<PersistedPayload['meta']>['autoBlacklist']>[string] } | { ok: false; error: string } => {
  if (!config.autoBlacklistEnabled) return { ok: false, error: 'AUTO_BLACKLIST_ENABLED=false' };

  const symbol = (params.symbol ?? '').toUpperCase();
  if (!isSymbolKey(symbol)) return { ok: false, error: 'Invalid symbol key' };

  const now = Date.now();
  const ttlMin = Math.max(5, Math.floor(config.autoBlacklistTtlMinutes));
  const ttlRequested = Number.isFinite(params.ttlMinutes ?? NaN) ? Math.floor(params.ttlMinutes ?? ttlMin) : ttlMin;
  const ttlMinutes = Math.max(ttlMin, Math.min(10_080, Math.max(1, ttlRequested)));

  const bannedUntil = now + ttlMinutes * 60_000;
  const existing = persisted.meta?.autoBlacklist ?? {};
  const prev = existing[symbol];

  const triggers = Array.isArray(params.triggers) ? params.triggers.filter(Boolean).slice(0, 8) : undefined;
  const entry = {
    at: now,
    bannedUntil: Math.max(prev?.bannedUntil ?? 0, bannedUntil),
    ttlMinutes,
    reason: params.reason.slice(0, 400),
    source: params.source,
    triggers,
  } satisfies NonNullable<NonNullable<PersistedPayload['meta']>['autoBlacklist']>[string];

  persistMeta(persisted, { autoBlacklist: { ...existing, [symbol]: entry } });
  persistAutoBlacklistEvent({
    at: entry.at,
    symbol,
    bannedUntil: entry.bannedUntil,
    ttlMinutes: entry.ttlMinutes,
    reason: entry.reason,
    source: entry.source,
    triggers: entry.triggers,
  });
  return { ok: true, entry };
};
