import { ReactNode } from 'react';

export type ChipTone = 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'danger';

export const Chip = (props: { tone?: ChipTone; children: ReactNode; title?: string; className?: string }) => {
  const tone = props.tone ?? 'neutral';
  const cls = ['chip', `chip-${tone}`, props.className].filter(Boolean).join(' ');
  return (
    <span className={cls} title={props.title}>
      {props.children}
    </span>
  );
};

