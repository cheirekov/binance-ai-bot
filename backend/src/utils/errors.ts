type ResponseLike = {
  status?: number;
  data?: unknown;
};

type AxiosishError = {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
  response?: ResponseLike;
};

const stringifySafely = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const summarizeData = (data: unknown): unknown => {
  if (data === undefined) return undefined;
  if (data === null) return null;
  if (typeof data === 'string') return data.length > 500 ? `${data.slice(0, 500)}…` : data;
  if (typeof data !== 'object') return data;
  const rec = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof rec.code === 'number' || typeof rec.code === 'string') out.code = rec.code;
  if (typeof rec.msg === 'string') out.msg = rec.msg;
  if (typeof rec.message === 'string') out.message = rec.message;
  return Object.keys(out).length > 0 ? out : rec;
};

const messageFromBinancePayload = (payload: unknown): string | null => {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const rec = payload as Record<string, unknown>;
  const msg = typeof rec.msg === 'string' ? rec.msg : typeof rec.message === 'string' ? rec.message : null;
  const code = typeof rec.code === 'number' || typeof rec.code === 'string' ? String(rec.code) : null;
  if (!msg && !code) return null;
  if (code && msg) return `Binance error ${code}: ${msg}`;
  return msg ?? `Binance error ${code}`;
};

export const errorToString = (error: unknown): string => {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error);

  if (error instanceof Error) {
    const anyErr = error as unknown as AxiosishError;
    const fromResponse = messageFromBinancePayload(anyErr.response?.data);
    return fromResponse ?? error.message ?? 'Unknown error';
  }

  if (typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    const fromBinance = messageFromBinancePayload(rec);
    if (fromBinance) return fromBinance;
    const msg = typeof rec.message === 'string' ? rec.message : null;
    if (msg) return msg;
    return stringifySafely(rec);
  }

  return 'Unknown error';
};

export const errorToLogObject = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const anyErr = error as unknown as AxiosishError;
    return {
      name: error.name,
      message: errorToString(error),
      code: anyErr.code,
      status: anyErr.response?.status,
      data: summarizeData(anyErr.response?.data),
      stack: error.stack,
    };
  }

  if (error === null || error === undefined) {
    return { message: 'Unknown error' };
  }

  if (typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    return {
      message: errorToString(error),
      code: rec.code,
      status: (rec.response as ResponseLike | undefined)?.status,
      data: summarizeData((rec.response as ResponseLike | undefined)?.data),
    };
  }

  return { message: errorToString(error) };
};

