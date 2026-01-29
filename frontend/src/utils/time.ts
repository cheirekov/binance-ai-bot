export const formatTime = (ts: number | null | undefined) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const formatDateTimeShort = (ts: number | null | undefined) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const formatAgo = (ts: number | null | undefined, now = Date.now()) => {
  if (!ts) return '—';
  const diffMs = Math.max(0, now - ts);
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
};

