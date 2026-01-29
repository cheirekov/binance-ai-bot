import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

type ToastItem = {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
  createdAt: number;
};

type ToastApi = {
  push: (toast: Omit<ToastItem, 'id' | 'createdAt'> & { ttlMs?: number }) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const makeId = () => Math.random().toString(16).slice(2) + Date.now().toString(16);

export const ToastProvider = (props: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<ToastItem, 'id' | 'createdAt'> & { ttlMs?: number }) => {
      const id = makeId();
      const createdAt = Date.now();
      const item: ToastItem = { id, createdAt, kind: toast.kind, title: toast.title, message: toast.message };
      setToasts((prev) => [item, ...prev].slice(0, 6));
      const ttlMs = toast.ttlMs ?? (toast.kind === 'error' ? 7000 : 4500);
      window.setTimeout(() => remove(id), ttlMs);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (message, title) => push({ kind: 'success', message, title }),
      error: (message, title) => push({ kind: 'error', message, title }),
      info: (message, title) => push({ kind: 'info', message, title }),
      warning: (message, title) => push({ kind: 'warning', message, title }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <div className="toast-viewport" aria-live="polite" aria-relevant="additions removals">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <div className="toast-main">
              {t.title ? <div className="toast-title">{t.title}</div> : null}
              <div className="toast-msg">{t.message}</div>
            </div>
            <button className="icon-btn" onClick={() => remove(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
};

