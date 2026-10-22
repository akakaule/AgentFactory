import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  /** Small line above the title (e.g. "F1 · Evidence"). */
  eyebrow?: ReactNode;
  /** Shown under the title. */
  subtitle?: ReactNode;
  /** 'side' = the right-hand evidence panel; 'center' = a confirm dialog. */
  variant: 'side' | 'center';
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The review panel's overlays: a modal dialog over the task drawer. Esc or the close button closes
 * it and focus returns to whatever opened it. The drawer skips its own Esc while one is open (it
 * checks for `.af-rv-overlay`).
 */
export function ReviewDialog({ title, eyebrow, subtitle, variant, onClose, footer, children }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // focus the first field when there is one, else the dialog itself
    const field = ref.current?.querySelector<HTMLElement>('textarea, input');
    (field ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); opener?.focus(); };
  }, []);

  return (
    <div className={'af-rv-overlay ' + variant} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="af-rv-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="af-rv-dhead">
          <div className="tx">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <button type="button" className="af-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="af-rv-dbody">{children}</div>
        {footer && <div className="af-rv-dfoot">{footer}</div>}
      </div>
    </div>
  );
}
