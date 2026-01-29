import { ReactNode } from 'react';

export const SegmentedControl = <T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; badge?: ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) => {
  return (
    <div className="segmented" role="group" aria-label={props.ariaLabel}>
      {props.options.map((opt) => (
        <button
          key={opt.value}
          className={opt.value === props.value ? 'segmented-btn active' : 'segmented-btn'}
          disabled={opt.disabled}
          onClick={() => props.onChange(opt.value)}
          type="button"
        >
          <span>{opt.label}</span>
          {opt.badge ? <span className="segmented-badge">{opt.badge}</span> : null}
        </button>
      ))}
    </div>
  );
};

