// Dialogs on the native <dialog> element (docs/wave9-plan.md step 9a.2): the browser keeps focus inside, Esc closes,
// and focus returns to what opened it. One look for every dialog: title, optional description, body, footer buttons.
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from './cx';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  role = 'dialog',
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** `alertdialog` for questions that must be answered (confirmations, errors). */
  role?: 'dialog' | 'alertdialog';
  /** False keeps it open on Esc and backdrop clicks: the person must choose. */
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-modal="true"
      onCancel={(e) => {
        // Esc: the native dialog would close itself; keep React in charge of `open`.
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onClick={(e) => {
        if (dismissable && e.target === ref.current) onClose();
      }}
      className={cx(
        'm-auto w-[calc(100%-2rem)] animate-enter rounded-lg border border-line bg-surface p-0 text-fg shadow-lg',
        widths[size],
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <div id={descId} className="mt-1 text-sm text-fg-muted">
              {description}
            </div>
          )}
        </div>
        {dismissable && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-sm p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {children && <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-sm">{children}</div>}
      {footer && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      )}
      {!children && !footer && <div className="pb-5" />}
    </dialog>
  );
}
