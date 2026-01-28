import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  getOcoOrder,
  getOpenOcoOrders,
  getOpenOrders,
  getOrderHistory,
} from '../binance/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getPersistedState } from '../services/persistence.js';
import { errorToLogObject, errorToString } from '../utils/errors.js';

const persisted = getPersistedState();

const csvToSymbols = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean)
    .filter((v) => /^[A-Z0-9]{3,30}$/.test(v));
};

const querySchema = z.object({
  symbol: z.string().optional(),
  symbols: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const normalizeSymbol = (value?: string) => {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(upper)) throw new Error('Invalid symbol');
  return upper;
};

const buildTrackedSymbols = () => {
  const set = new Set<string>();
  const active = persisted.meta?.activeSymbol;
  if (active) set.add(active.toUpperCase());
  for (const pos of Object.values(persisted.positions ?? {})) {
    if (!pos) continue;
    if ((pos.venue ?? 'spot') !== config.tradeVenue) continue;
    set.add(pos.symbol.toUpperCase());
  }
  if (config.tradeVenue === 'spot') {
    for (const grid of Object.values(persisted.grids ?? {})) {
      if (!grid) continue;
      if (grid.status !== 'running') continue;
      set.add(grid.symbol.toUpperCase());
    }
  }
  return Array.from(set).slice(0, 12);
};

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const mapOrderCommon = (row: unknown) => {
  const rec = (row && typeof row === 'object' ? (row as Record<string, unknown>) : {}) as Record<string, unknown>;
  const symbol = String(rec.symbol ?? '').toUpperCase();
  const orderId = asNumber(rec.orderId) ?? 0;
  const clientOrderId = String(rec.clientOrderId ?? rec.origClientOrderId ?? '');
  const orderListId = asNumber(rec.orderListId);
  const side = String(rec.side ?? '').toUpperCase();
  const type = String(rec.type ?? '').toUpperCase();
  const status = String(rec.status ?? '').toUpperCase();
  const timeInForce = String(rec.timeInForce ?? '');
  const price = asNumber(rec.price) ?? 0;
  const stopPrice = asNumber(rec.stopPrice) ?? undefined;
  const origQty = asNumber(rec.origQty ?? rec.origQuantity ?? rec.quantity) ?? 0;
  const executedQty = asNumber(rec.executedQty ?? rec.executedQuantity) ?? 0;
  const cummulativeQuoteQty = asNumber(rec.cummulativeQuoteQty ?? rec.cumulativeQuoteQty ?? rec.cumQuote ?? rec.cumQuoteQty) ?? 0;
  const time = asNumber(rec.time ?? rec.transactTime ?? rec.updateTime) ?? 0;
  const updateTime = asNumber(rec.updateTime ?? rec.time) ?? 0;
  return {
    symbol,
    orderId,
    clientOrderId,
    orderListId: orderListId !== null && orderListId !== undefined ? orderListId : undefined,
    side,
    type,
    status,
    timeInForce,
    price,
    stopPrice,
    origQty,
    executedQty,
    cummulativeQuoteQty,
    time,
    updateTime,
  };
};

const buildBotMappings = async () => {
  const gridOrderIdMap = new Map<number, { symbol: string; levelKey: string }>();
  if (config.tradeVenue === 'spot') {
    for (const grid of Object.values(persisted.grids ?? {})) {
      if (!grid) continue;
      for (const [levelKey, o] of Object.entries(grid.ordersByLevel ?? {})) {
        const id = Number(o.orderId);
        if (Number.isFinite(id) && id > 0) gridOrderIdMap.set(id, { symbol: grid.symbol.toUpperCase(), levelKey });
      }
    }
  }

  const ocoOrderIdToListId = new Map<number, number>();
  const ocoListIdToPositionKey = new Map<number, string>();
  for (const [key, pos] of Object.entries(persisted.positions ?? {})) {
    if (!pos) continue;
    if ((pos.venue ?? 'spot') !== 'spot') continue;
    if (typeof pos.ocoOrderListId === 'number') {
      ocoListIdToPositionKey.set(pos.ocoOrderListId, key);
    }
  }

  if (config.tradeVenue === 'spot') {
    try {
      const openOco = await getOpenOcoOrders();
      const listIds = openOco
        .map((o) => {
          const rec = o as Record<string, unknown>;
          return asNumber(rec.orderListId);
        })
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
        .slice(0, 20);
      for (const listId of listIds) {
        try {
          const detail = await getOcoOrder(listId);
          const rec = detail as Record<string, unknown>;
          const reports = (rec.orderReports as unknown[]) ?? [];
          for (const r of reports) {
            const rr = r as Record<string, unknown>;
            const oid = asNumber(rr.orderId);
            if (typeof oid === 'number' && Number.isFinite(oid) && oid > 0) {
              ocoOrderIdToListId.set(oid, listId);
            }
          }
        } catch (error) {
          logger.warn({ err: errorToLogObject(error), orderListId: listId }, 'Failed to fetch OCO detail');
        }
      }
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Failed to fetch open OCO orders');
    }
  }

  const symbolToPositionKeys = new Map<string, string[]>();
  for (const [key, pos] of Object.entries(persisted.positions ?? {})) {
    if (!pos) continue;
    if ((pos.venue ?? 'spot') !== config.tradeVenue) continue;
    const sym = pos.symbol.toUpperCase();
    const list = symbolToPositionKeys.get(sym) ?? [];
    list.push(key);
    symbolToPositionKeys.set(sym, list);
  }

  return { gridOrderIdMap, ocoOrderIdToListId, ocoListIdToPositionKey, symbolToPositionKeys };
};

export async function ordersRoutes(fastify: FastifyInstance) {
  fastify.get('/orders/open', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: parsed.error.flatten() };
    }

    let symbol: string | undefined;
    try {
      symbol = normalizeSymbol(parsed.data.symbol);
    } catch (error) {
      reply.status(400);
      return { error: error instanceof Error ? error.message : 'Invalid symbol' };
    }

    const symbols = Array.from(
      new Set<string>([
        ...(symbol ? [symbol] : []),
        ...csvToSymbols(parsed.data.symbols),
      ]),
    );
    const wanted = symbols.length ? symbols : buildTrackedSymbols();

    try {
      const mappings = await buildBotMappings();

      // Spot supports a single account-wide open-orders call; use it when querying many symbols.
      const openRows = await getOpenOrders(
        config.tradeVenue === 'spot' && wanted.length > 3 ? undefined : wanted[0],
      );
      const openOrders = openRows
        .map(mapOrderCommon)
        .filter((o) => (wanted.length ? wanted.includes(o.symbol) : true))
        .map((o) => {
          const grid = mappings.gridOrderIdMap.get(o.orderId);
          const ocoListId = mappings.ocoOrderIdToListId.get(o.orderId);
          const positionKey =
            (ocoListId ? mappings.ocoListIdToPositionKey.get(ocoListId) : undefined) ??
            (mappings.symbolToPositionKeys.get(o.symbol)?.length === 1 ? mappings.symbolToPositionKeys.get(o.symbol)?.[0] : undefined);
          const ai = persisted.meta?.aiPolicy?.lastDecision;
          const aiRelevant = !!ai && ((positionKey && ai.positionKey === positionKey) || (!!ai.symbol && ai.symbol.toUpperCase() === o.symbol));
          return {
            ...o,
            bot: {
              source: grid ? 'grid' : positionKey ? 'position' : 'unknown',
              gridSymbol: grid?.symbol,
              gridLevel: grid?.levelKey,
              positionKey,
              ocoOrderListId: ocoListId,
              ai: aiRelevant && ai
                ? {
                    at: ai.at,
                    action: ai.action,
                    confidence: ai.confidence,
                    symbol: ai.symbol,
                    horizon: ai.horizon,
                    positionKey: ai.positionKey,
                    reason: ai.reason,
                  }
                : undefined,
            },
          };
        })
        .sort((a, b) => (b.updateTime ?? b.time ?? 0) - (a.updateTime ?? a.time ?? 0));

      return { ok: true, venue: config.tradeVenue, symbols: wanted, openOrders };
    } catch (error) {
      logger.warn({ err: errorToLogObject(error) }, 'Open orders fetch failed');
      reply.status(500);
      return { error: errorToString(error) };
    }
  });

  fastify.get('/orders/history', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: parsed.error.flatten() };
    }

    let symbol: string | undefined;
    try {
      symbol = normalizeSymbol(parsed.data.symbol);
    } catch (error) {
      reply.status(400);
      return { error: error instanceof Error ? error.message : 'Invalid symbol' };
    }
    if (!symbol) {
      reply.status(400);
      return { error: 'symbol is required for history' };
    }

    const limit = parsed.data.limit ?? 50;
    try {
      const mappings = await buildBotMappings();
      const rows = await getOrderHistory(symbol, limit);
      const orders = rows
        .map(mapOrderCommon)
        .map((o) => {
          const grid = mappings.gridOrderIdMap.get(o.orderId);
          const ocoListId = mappings.ocoOrderIdToListId.get(o.orderId);
          const positionKey =
            (ocoListId ? mappings.ocoListIdToPositionKey.get(ocoListId) : undefined) ??
            (mappings.symbolToPositionKeys.get(o.symbol)?.length === 1 ? mappings.symbolToPositionKeys.get(o.symbol)?.[0] : undefined);
          const ai = persisted.meta?.aiPolicy?.lastDecision;
          const aiRelevant = !!ai && ((positionKey && ai.positionKey === positionKey) || (!!ai.symbol && ai.symbol.toUpperCase() === o.symbol));
          return {
            ...o,
            bot: {
              source: grid ? 'grid' : positionKey ? 'position' : 'unknown',
              gridSymbol: grid?.symbol,
              gridLevel: grid?.levelKey,
              positionKey,
              ocoOrderListId: ocoListId,
              ai: aiRelevant && ai
                ? {
                    at: ai.at,
                    action: ai.action,
                    confidence: ai.confidence,
                    symbol: ai.symbol,
                    horizon: ai.horizon,
                    positionKey: ai.positionKey,
                    reason: ai.reason,
                  }
                : undefined,
            },
          };
        })
        .sort((a, b) => (b.updateTime ?? b.time ?? 0) - (a.updateTime ?? a.time ?? 0));
      return { ok: true, venue: config.tradeVenue, symbol, orders };
    } catch (error) {
      logger.warn({ err: errorToLogObject(error), symbol }, 'Order history fetch failed');
      reply.status(500);
      return { error: errorToString(error) };
    }
  });
}
