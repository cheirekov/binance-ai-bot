import { getKlines, Kline } from '../binance/client.js';

export interface BollingerBandsSnapshot {
  middle: number | null;
  upper: number | null;
  lower: number | null;
  stdDev: number | null;
}

export interface IndicatorSnapshot {
  symbol: string;
  interval: string;
  asOf: number;
  close: number;
  volume: number;
  avgVolume20: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  bb20: BollingerBandsSnapshot;
}

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);

const stdDev = (values: number[]): number => {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

export const computeEma = (values: number[], period: number): number | null => {
  if (period <= 0) return null;
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha);
  }
  return Number.isFinite(ema) ? ema : null;
};

export const computeRsi = (closes: number[], period: number): number | null => {
  if (period <= 0) return null;
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Number.isFinite(rsi) ? rsi : null;
};

const trueRangeAt = (klines: Pick<Kline, 'high' | 'low' | 'close'>[], index: number): number => {
  const curr = klines[index];
  const prevClose = klines[index - 1]?.close;
  const range = curr.high - curr.low;
  if (prevClose === undefined) return range;
  const hc = Math.abs(curr.high - prevClose);
  const lc = Math.abs(curr.low - prevClose);
  return Math.max(range, hc, lc);
};

export const computeAtr = (klines: Pick<Kline, 'high' | 'low' | 'close'>[], period: number): number | null => {
  if (period <= 0) return null;
  if (klines.length < period + 1) return null;

  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trueRangeAt(klines, i);
  atr /= period;

  for (let i = period + 1; i < klines.length; i++) {
    const tr = trueRangeAt(klines, i);
    atr = (atr * (period - 1) + tr) / period;
  }

  return Number.isFinite(atr) ? atr : null;
};

export const computeAdx = (klines: Pick<Kline, 'high' | 'low' | 'close'>[], period: number): number | null => {
  if (period <= 0) return null;
  if (klines.length < period * 2) return null;

  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    tr.push(trueRangeAt(klines, i));
    const upMove = klines[i].high - klines[i - 1].high;
    const downMove = klines[i - 1].low - klines[i].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let tr14 = tr.slice(0, period).reduce((sum, v) => sum + v, 0);
  let plus14 = plusDm.slice(0, period).reduce((sum, v) => sum + v, 0);
  let minus14 = minusDm.slice(0, period).reduce((sum, v) => sum + v, 0);

  const dx: number[] = [];
  // First DX is computed at index (period - 1) using the initial smoothed sums.
  for (let i = period - 1; i < tr.length; i++) {
    if (i >= period) {
      tr14 = tr14 - tr14 / period + tr[i];
      plus14 = plus14 - plus14 / period + plusDm[i];
      minus14 = minus14 - minus14 / period + minusDm[i];
    }

    const denomTr = tr14 === 0 ? 0 : tr14;
    const diPlus = denomTr > 0 ? (100 * plus14) / denomTr : 0;
    const diMinus = denomTr > 0 ? (100 * minus14) / denomTr : 0;
    const denom = diPlus + diMinus;
    const dxVal = denom === 0 ? 0 : (100 * Math.abs(diPlus - diMinus)) / denom;
    dx.push(dxVal);
  }

  if (dx.length < period) return null;

  let adx = mean(dx.slice(0, period));
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return Number.isFinite(adx) ? adx : null;
};

export const computeBollingerBands = (
  closes: number[],
  period: number,
  stdevMult: number,
): BollingerBandsSnapshot => {
  if (period <= 0) return { middle: null, upper: null, lower: null, stdDev: null };
  if (closes.length < period) return { middle: null, upper: null, lower: null, stdDev: null };

  const window = closes.slice(-period);
  const mid = mean(window);
  const sd = stdDev(window);
  return {
    middle: mid,
    upper: mid + sd * stdevMult,
    lower: mid - sd * stdevMult,
    stdDev: sd,
  };
};

export const computeIndicatorSnapshot = (symbol: string, interval: string, klines: Kline[]): IndicatorSnapshot => {
  const last = klines[klines.length - 1];
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const avgVol20 = volumes.length >= 20 ? mean(volumes.slice(-20)) : null;

  return {
    symbol: symbol.toUpperCase(),
    interval,
    asOf: last?.closeTime ?? Date.now(),
    close: last?.close ?? Number.NaN,
    volume: last?.volume ?? 0,
    avgVolume20: avgVol20,
    ema20: computeEma(closes, 20),
    ema50: computeEma(closes, 50),
    rsi14: computeRsi(closes, 14),
    atr14: computeAtr(klines, 14),
    adx14: computeAdx(klines, 14),
    bb20: computeBollingerBands(closes, 20, 2),
  };
};

export const fetchIndicatorSnapshot = async (
  symbol: string,
  interval: string,
  limit = 200,
): Promise<IndicatorSnapshot> => {
  const klines = await getKlines(symbol, interval, limit);
  return computeIndicatorSnapshot(symbol, interval, klines);
};
