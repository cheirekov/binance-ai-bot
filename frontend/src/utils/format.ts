export const formatCompactNumber = (value: number, options?: { maxDecimals?: number }) => {
  const maxDecimals = options?.maxDecimals ?? 8;
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(6, maxDecimals) });
  if (abs >= 0.01) return value.toLocaleString(undefined, { maximumFractionDigits: Math.min(8, maxDecimals) });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
};

export const formatPrice = (value: number | null | undefined, quoteAsset: string | undefined, digits = 8) => {
  if (value === null || value === undefined) return '—';
  const qa = quoteAsset?.toUpperCase();
  const fiatQuotes = ['USD', 'USDT', 'USDC', 'EUR', 'BUSD'];
  if (qa && fiatQuotes.includes(qa)) {
    const formatted = formatCompactNumber(value, { maxDecimals: 10 });
    if (qa === 'EUR') return `€${formatted}`;
    if (qa === 'USD') return `$${formatted}`;
    return `${formatted} ${qa}`;
  }
  return `${value.toFixed(digits)} ${qa ?? ''}`.trim();
};

export const formatOrderType = (type: string) => {
  const t = (type ?? '').toUpperCase();
  if (!t) return '—';
  const map: Record<string, string> = {
    LIMIT: 'LIMIT',
    MARKET: 'MARKET',
    LIMIT_MAKER: 'MAKER',
    STOP_LOSS_LIMIT: 'SL-LIMIT',
    STOP_LOSS: 'SL',
    TAKE_PROFIT_LIMIT: 'TP-LIMIT',
    TAKE_PROFIT: 'TP',
    STOP_MARKET: 'STOP-MKT',
    TAKE_PROFIT_MARKET: 'TP-MKT',
    TRAILING_STOP_MARKET: 'TRAIL',
  };
  return map[t] ?? t.replaceAll('_', '-');
};

