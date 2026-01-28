import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

export const Modal = (props: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  danger?: boolean;
}) => {
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props]);

  if (!props.open) return null;
  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={props.onClose}>
      <div
        className={props.danger ? 'modal modal-danger' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={typeof props.title === 'string' ? props.title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 className="modal-title">{props.title}</h3>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.actions ? <div className="modal-actions">{props.actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
};

