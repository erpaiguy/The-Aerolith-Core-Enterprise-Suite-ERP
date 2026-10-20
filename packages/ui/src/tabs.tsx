// Tabs with the keyboard behaviour screen-reader users expect (docs/wave9-plan.md steps 9a.1 and 9a.8): one tab stop,
// arrow keys move between tabs, Home and End jump to the ends.
import { useId, useRef, type ReactNode } from 'react';
import { cx } from './cx';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** A count or a dot beside the label. */
  badge?: ReactNode;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Names the tab list for screen readers. */
  label: string;
  /** The selected tab's panel. */
  children?: ReactNode;
}) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    onChange(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  const at = tabs.findIndex((t) => t.id === value);
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-line"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') move(at + 1);
          else if (e.key === 'ArrowLeft') move(at - 1);
          else if (e.key === 'Home') move(0);
          else if (e.key === 'End') move(tabs.length - 1);
          else return;
          e.preventDefault();
        }}
      >
        {tabs.map((t, i) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={on}
              // Only a tab list that shows its panel points at it (a filter strip has none).
              aria-controls={children !== undefined ? `${base}-panel` : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cx(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
                on
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg',
              )}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className="rounded-sm bg-surface-2 px-1.5 text-xs text-fg-muted">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${value}`}
          className="pt-4"
        >
          {children}
        </div>
      )}
    </div>
  );
}
