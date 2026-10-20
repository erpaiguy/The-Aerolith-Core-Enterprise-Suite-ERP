// Small UI kit on Tailwind, shared by the tenant app and the owner console. Colours come from CSS variables in
// tokens.css so light and dark themes stay in one place.
import {
  cloneElement,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';

import { cx } from './cx';

export { cx } from './cx';
export {
  DataGrid,
  type GridColumn,
  type GridDensity,
  type GridLayout,
  type GridSort,
  type GridState,
  type GridStorage,
  type GridValue,
  type GridView,
} from './data-grid';
export { Dialog } from './dialog';
export {
  ConfirmProvider,
  EmptyState,
  ErrorDialogHost,
  Toaster,
  currentToasts,
  dismissToast,
  showErrorDialog,
  toast,
  useConfirm,
  type ConfirmOptions,
  type ErrorReport,
  type Toast,
  type ToastTone,
} from './feedback';
export { Tabs, type TabItem } from './tabs';
export { crc32, downloadBlob, xlsxBlob, xlsxBytes, zipStore, type XlsxValue } from './xlsx';

const controlClass =
  'block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-60';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
    secondary: 'bg-surface-2 text-fg border border-line hover:bg-surface-3',
    danger: 'bg-danger text-danger-fg hover:opacity-90',
    ghost: 'text-fg-muted hover:bg-surface-2',
  };
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles[variant],
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/**
 * Label + control + hint/error. The label names the control; the hint and error are linked with aria-describedby so
 * screen readers announce them separately. `children` must be a single input-like element.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const control = cloneElement(children, {
    id,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  } as Record<string, unknown>);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {control}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(controlClass, className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(controlClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(controlClass, 'min-h-[5rem]', className)} {...rest} />;
}

/** Page title row with optional actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-fg-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Responsive table inside a Card: scrolls sideways within the card instead of widening the page. */
export function Table({
  children,
  minWidth = '40rem',
}: {
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table
        style={{ minWidth }}
        className="w-full text-left text-sm [&_td]:px-5 [&_td]:py-2.5 [&_th]:px-5 [&_th]:pb-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-fg-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line"
      >
        {children}
      </table>
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warning' | undefined;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div
        className={cx(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'danger' && 'text-danger',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface p-5', className)}>
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  const styles = {
    info: 'border-info/30 bg-info/10 text-fg',
    success: 'border-success/30 bg-success/10 text-fg',
    warning: 'border-warning/40 bg-warning/10 text-fg',
    danger: 'border-danger/30 bg-danger/10 text-fg',
  };
  const iconColour = {
    info: 'text-info',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  };
  return (
    <div
      className={cx('flex gap-2.5 rounded-md border px-3.5 py-2.5 text-sm', styles[tone])}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon className={cx('mt-0.5 size-4 shrink-0', iconColour[tone])} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'bg-surface-2 text-fg-muted',
    accent: 'bg-accent/15 text-accent',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger/15 text-danger',
    success: 'bg-success/15 text-success',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium',
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-fg-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

/** Centered card layout for sign-in, activation and password screens. */
export function AuthLayout({
  title,
  subtitle,
  footer = 'Aerolith Core · Construction ERP',
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-accent font-bold text-accent-fg">
            A
          </div>
          <h1 className="text-xl font-semibold text-fg">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">{children}</div>
        <div className="mt-6 text-center text-xs text-fg-subtle">{footer}</div>
      </div>
    </main>
  );
}
