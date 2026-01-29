import { ReactNode } from 'react';

export type NavTabId = 'home' | 'portfolio' | 'orders' | 'strategy' | 'status';

export const BottomNav = (props: {
  active: NavTabId;
  tabs: Array<{ id: NavTabId; label: string; icon?: ReactNode; disabled?: boolean }>;
  onChange: (id: NavTabId) => void;
}) => {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          className={t.id === props.active ? 'bottom-nav-btn active' : 'bottom-nav-btn'}
          onClick={() => props.onChange(t.id)}
          disabled={t.disabled}
          aria-current={t.id === props.active ? 'page' : undefined}
          type="button"
        >
          <span className="bottom-nav-icon" aria-hidden="true">
            {t.icon ?? '•'}
          </span>
          <span className="bottom-nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
};

