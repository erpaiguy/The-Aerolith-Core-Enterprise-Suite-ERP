// Feedback that is seen (docs/wave9-plan.md step 9a.2): toasts for what just happened, a confirmation before anything
// that cannot be undone, an error dialog that says what went wrong, what to do and a reference to quote, and empty
// states that say how to begin. The toast queue lives outside React so code with no hook (the API client) can use it.
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import { Dialog } from './dialog';

// --- toasts ---

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string | undefined;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(tone: ToastTone, title: string, body?: string, ms?: number) {
  const id = nextId++;
  // At most four on screen; the oldest goes first.
  toasts = [...toasts.slice(-3), { id, tone, title, body }];
  emit();
  // Failures stay longer: there is more to read and it matters more.
  const life = ms ?? (tone === 'danger' ? 10_000 : tone === 'warning' ? 7_000 : 4_000);
  if (life > 0) setTimeout(() => dismissToast(id), life);
  return id;
}

/** `toast.success('Saved')`, `toast.error('Could not send', 'The mail server refused it.')`. */
export const toast = {
  success: (title: string, body?: string, ms?: number) => push('success', title, body, ms),
  info: (title: string, body?: string, ms?: number) => push('info', title, body, ms),
  warning: (title: string, body?: string, ms?: number) => push('warning', title, body, ms),
  error: (title: string, body?: string, ms?: number) => push('danger', title, body, ms),
};

/** For tests: what is on screen now. */
export const currentToasts = () => toasts;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const TONE_ICON: Record<ToastTone, ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
};
const TONE_TEXT: Record<ToastTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Rendered once, at the root of the app. Polite for news, assertive for failures. */
export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  const region = (tones: ToastTone[], live: 'polite' | 'assertive') => (
    <div aria-live={live} role={live === 'assertive' ? 'alert' : 'status'} className="contents">
      {list
        .filter((t) => tones.includes(t.tone))
        .map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              data-toast={t.tone}
              className="pointer-events-auto flex w-full animate-enter items-start gap-3 rounded-md border border-line bg-surface p-3 text-sm text-fg shadow-md"
            >
              <Icon className={cx('mt-0.5 size-4 shrink-0', TONE_TEXT[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 text-fg-muted">{t.body}</div>}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss"
                className="rounded-sm p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          );
        })}
    </div>
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-50 flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2 print:hidden">
      {region(['success', 'info'], 'polite')}
      {region(['warning', 'danger'], 'assertive')}
    </div>
  );
}

// --- confirmations ---

export interface ConfirmOptions {
  title: string;
  /** What will happen, in the person's words: "Its demands are reversed by credit notes." */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /** For the gravest steps (closing a year): the person types this to enable the button. */
  typeToConfirm?: string;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Ask | null>(null);

/** `const confirm = useConfirm(); if (!(await confirm({ title: 'Delete it?', tone: 'danger' }))) return;` */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm needs a <ConfirmProvider> above it.');
  return ask;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback<Ask>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setTyped('');
        setOpen(o);
      }),
    [],
  );
  const answer = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(null);
  };
  const blocked = !!open?.typeToConfirm && typed.trim() !== open.typeToConfirm;
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog
        open={!!open}
        onClose={() => answer(false)}
        role="alertdialog"
        size="sm"
        title={open?.title ?? ''}
        description={open?.body}
        footer={
          <>
            <button
              type="button"
              autoFocus
              onClick={() => answer(false)}
              className="inline-flex items-center justify-center rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium text-fg hover:bg-surface-3"
            >
              {open?.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => answer(true)}
              data-confirm
              className={cx(
                'inline-flex items-center justify-center rounded-md px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
                open?.tone === 'danger'
                  ? 'bg-danger text-danger-fg hover:opacity-90'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover',
              )}
            >
              {open?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      >
        {open?.typeToConfirm ? (
          <label className="block space-y-1.5">
            <span className="block text-sm">
              Type <strong className="font-mono">{open.typeToConfirm}</strong> to confirm.
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            />
          </label>
        ) : undefined}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

// --- error dialog ---

export interface ErrorReport {
  title: string;
  /** What went wrong, plainly. */
  message: string;
  /** What to do about it. */
  advice?: string | undefined;
  /** The reference support can find in the server's log. */
  reference?: string | undefined;
}

let errorListener: ((e: ErrorReport) => void) | null = null;
/** Shows the error dialog from anywhere (the API client calls this for server faults). */
export function showErrorDialog(e: ErrorReport) {
  errorListener?.(e);
}

/** Rendered once at the root; shows one error at a time, the latest. */
export function ErrorDialogHost() {
  const [e, setE] = useState<ErrorReport | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    errorListener = (r) => {
      setCopied(false);
      setE(r);
    };
    return () => {
      errorListener = null;
    };
  }, []);
  return (
    <Dialog
      open={!!e}
      onClose={() => setE(null)}
      role="alertdialog"
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <XCircle className="size-5 text-danger" aria-hidden />
          {e?.title}
        </span>
      }
      footer={
        <button
          type="button"
          autoFocus
          onClick={() => setE(null)}
          className="inline-flex items-center justify-center rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          OK
        </button>
      }
    >
      <p>{e?.message}</p>
      {e?.advice && <p className="mt-2 text-fg-muted">{e.advice}</p>}
      {e?.reference && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-fg-muted">
          Reference for support:
          <code className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-fg">
            {e.reference}
          </code>
          <button
            type="button"
            className="text-xs text-accent underline"
            onClick={() => {
              void navigator.clipboard?.writeText(e.reference!).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </p>
      )}
    </Dialog>
  );
}

// --- empty states ---

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  /** How to begin. */
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {Icon && (
        <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <div className="max-w-md text-sm text-fg-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
