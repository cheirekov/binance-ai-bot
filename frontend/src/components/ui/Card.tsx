import { ReactNode } from 'react';

export const Card = (props: {
  eyebrow?: string;
  title?: ReactNode;
  right?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  children: ReactNode;
}) => {
  return (
    <section className={props.className ? `card ${props.className}` : 'card'}>
      {(props.eyebrow || props.title || props.right) && (
        <header className="card-header">
          <div>
            {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
            {props.title ? <h3 className="card-title">{props.title}</h3> : null}
            {props.subtitle ? <p className="muted">{props.subtitle}</p> : null}
          </div>
          {props.right ? <div className="card-right">{props.right}</div> : null}
        </header>
      )}
      {props.children}
    </section>
  );
};

