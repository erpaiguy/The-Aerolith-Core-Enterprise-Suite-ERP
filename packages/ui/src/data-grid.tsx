// The data grid of the list screens (docs/wave9-plan.md step 9a.5): a real <table> a person can shape to their work.
// Choose and reorder the columns, drag (or arrow-key) a header edge to resize, freeze the first columns, pick the row
// density, sort by a header, save a layout as a named view, and export the rows as shown to Excel. The layout is kept
// through `storage` (the app keeps it per person on the server) or `state`/`onStateChange`.
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Columns3,
  FileSpreadsheet,
} from 'lucide-react';
import {
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import { downloadBlob, xlsxBlob, type XlsxValue } from './xlsx';

export type GridValue = string | number | null | Date;

export interface GridColumn<T> {
  /** Stable key: layouts are saved by it. */
  id: string;
  header: ReactNode;
  /** The column's name in the Columns menu and the Excel header, when `header` is not plain text. */
  label?: string;
  cell: (row: T) => ReactNode;
  /** The plain value, for sorting and for Excel. */
  value?: (row: T) => GridValue;
  align?: 'left' | 'right';
  /** Width in pixels before the person resizes it. */
  width?: number;
  /** False keeps the column always shown. */
  hideable?: boolean;
  /** Defaults to true when `value` is given. */
  sortable?: boolean;
  /** False leaves the column out of Excel (buttons and other actions). */
  exportable?: boolean;
}

export type GridDensity = 'comfortable' | 'compact';
export interface GridSort {
  id: string;
  dir: 'asc' | 'desc';
}
export interface GridLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  frozen: number;
  density: GridDensity;
  sort: GridSort | null;
}
export interface GridView {
  name: string;
  layout: GridLayout;
}
export interface GridState extends GridLayout {
  views: GridView[];
  /** The saved view last picked, if any. */
  view: string | null;
}
export interface GridStorage {
  get(): GridState | undefined;
  /** null forgets the layout (back to the default). */
  set(s: GridState | null): void;
}

const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 48;
const MAX_WIDTH = 800;
const MAX_FROZEN = 3;
const clampWidth = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

const DEFAULT_LAYOUT: GridLayout = {
  order: [],
  hidden: [],
  widths: {},
  frozen: 0,
  density: 'comfortable',
  sort: null,
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Reads a layout defensively: what is stored may come from an older version of the screen. */
function cleanLayout(raw: unknown): GridLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const widths: Record<string, number> = {};
  if (r.widths && typeof r.widths === 'object')
    for (const [k, v] of Object.entries(r.widths as Record<string, unknown>))
      if (typeof v === 'number' && Number.isFinite(v)) widths[k] = clampWidth(v);
  const sort = r.sort as Partial<GridSort> | null | undefined;
  return {
    order: strings(r.order),
    hidden: strings(r.hidden),
    widths,
    frozen:
      typeof r.frozen === 'number' ? Math.min(MAX_FROZEN, Math.max(0, Math.floor(r.frozen))) : 0,
    density: r.density === 'compact' ? 'compact' : 'comfortable',
    sort:
      sort && typeof sort.id === 'string' && (sort.dir === 'asc' || sort.dir === 'desc')
        ? { id: sort.id, dir: sort.dir }
        : null,
  };
}

function cleanState(raw: unknown): GridState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const views = Array.isArray(r.views)
    ? (r.views as unknown[]).flatMap((v) => {
        const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        return typeof o.name === 'string' && o.name
          ? [{ name: o.name, layout: cleanLayout(o.layout) }]
          : [];
      })
    : [];
  return {
    ...cleanLayout(raw),
    views,
    view: typeof r.view === 'string' && views.some((v) => v.name === r.view) ? r.view : null,
  };
}

const layoutOf = (s: GridState): GridLayout => ({
  order: s.order,
  hidden: s.hidden,
  widths: s.widths,
  frozen: s.frozen,
  density: s.density,
  sort: s.sort,
});

const nameOf = <T,>(c: GridColumn<T>) =>
  c.label ??
  (typeof c.header === 'string' || typeof c.header === 'number' ? String(c.header) : c.id);

const isSortable = <T,>(c: GridColumn<T>) => c.sortable ?? Boolean(c.value);

/** A cell's text for Excel when the column gives no `value`. */
function plainText(node: ReactNode): XlsxValue {
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((n) => plainText(n) ?? '').join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return null;
}

function compare(a: GridValue, b: GridValue): number {
  if (a === null || a === '') return b === null || b === '' ? 0 : 1;
  if (b === null || b === '') return -1;
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
}

const control =
  'rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent';
const toolButton =
  'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';
const iconButton =
  'rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30';

export function DataGrid<T>({
  id,
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  exportName,
  label,
  state,
  onStateChange,
  storage,
}: {
  /** Stable key of this grid, e.g. 'orders'. */
  id: string;
  columns: GridColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** File name of the Excel export, without .xlsx; the grid's id by default. */
  exportName?: string;
  /** Names the table (and its body) for screen readers. */
  label: string;
  state?: GridState;
  onStateChange?: (s: GridState) => void;
  storage?: GridStorage;
}) {
  const uid = useId();
  const [own, setOwn] = useState<GridState | null>(null);
  const s = cleanState(state ?? (storage ? storage.get() : own));
  const latest = useRef(s);
  latest.current = s;

  const commit = (next: GridState | null) => {
    setOwn(next);
    onStateChange?.(next ?? cleanState(null));
    storage?.set(next);
  };
  const patch = (p: Partial<GridLayout>) => commit({ ...latest.current, ...p });

  // Columns in the person's order; columns added to the screen since the layout was saved go where they are defined.
  const ordered = useMemo(() => {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: GridColumn<T>[] = [];
    for (const k of s.order) {
      const c = byId.get(k);
      if (c && !seen.has(k)) {
        out.push(c);
        seen.add(k);
      }
    }
    columns.forEach((c, i) => {
      if (seen.has(c.id)) return;
      const prev = i > 0 ? out.findIndex((o) => o.id === columns[i - 1]!.id) : -1;
      out.splice(prev + 1, 0, c);
      seen.add(c.id);
    });
    return out;
  }, [columns, s.order]);

  const shown = ordered.filter((c) => c.hideable === false || !s.hidden.includes(c.id));
  const visible = shown.length ? shown : ordered.slice(0, 1);
  const frozen = Math.min(s.frozen, visible.length);

  const [live, setLive] = useState<{ id: string; width: number } | null>(null);
  const widthOf = (c: GridColumn<T>) =>
    live?.id === c.id ? live.width : (s.widths[c.id] ?? c.width ?? DEFAULT_WIDTH);
  const lefts: number[] = [];
  visible.reduce((x, c, i) => {
    lefts[i] = x;
    return x + widthOf(c);
  }, 0);
  const total = visible.reduce((n, c) => n + widthOf(c), 0);

  const sortCol = s.sort ? columns.find((c) => c.id === s.sort!.id && isSortable(c)) : undefined;
  const sorted = useMemo(() => {
    if (!sortCol?.value || !s.sort) return rows;
    const get = sortCol.value;
    const dir = s.sort.dir === 'asc' ? 1 : -1;
    return rows
      .map((r, i) => ({ r, i, v: get(r) }))
      .sort((a, b) => {
        // empty values stay last whichever way the sort runs
        const empty = (v: GridValue) => v === null || v === '';
        if (empty(a.v) !== empty(b.v)) return empty(a.v) ? 1 : -1;
        return compare(a.v, b.v) * dir || a.i - b.i;
      })
      .map((x) => x.r);
  }, [rows, sortCol, s.sort]);

  const toggleSort = (c: GridColumn<T>) => {
    const cur = s.sort?.id === c.id ? s.sort.dir : null;
    patch({
      sort:
        cur === null ? { id: c.id, dir: 'asc' } : cur === 'asc' ? { id: c.id, dir: 'desc' } : null,
    });
  };

  const setWidth = (colId: string, w: number) =>
    patch({ widths: { ...latest.current.widths, [colId]: clampWidth(w) } });

  const startResize = (c: GridColumn<T>, e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widthOf(c);
    const at = (ev: PointerEvent) => clampWidth(start + ev.clientX - startX);
    const move = (ev: PointerEvent) => setLive({ id: c.id, width: at(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      setWidth(c.id, at(ev));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const resizeKey = (c: GridColumn<T>, e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth(c.id, widthOf(c) + (e.key === 'ArrowRight' ? step : -step));
    }
  };

  const sticky = (i: number, head = false): CSSProperties | undefined =>
    i < frozen ? { position: 'sticky', left: lefts[i], zIndex: head ? 2 : 1 } : undefined;

  const exportXlsx = () => {
    const out = visible.filter((c) => c.exportable !== false);
    const head = out.map(nameOf);
    const body = sorted.map((r) => out.map((c) => (c.value ? c.value(r) : plainText(c.cell(r)))));
    downloadBlob(
      xlsxBlob([head, ...body], { sheetName: label, widths: out.map(widthOf) }),
      `${exportName ?? id}.xlsx`,
    );
  };

  if (!rows.length && empty !== undefined) return <>{empty}</>;

  return (
    <div data-grid={id}>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        {s.views.length > 0 && (
          <select
            aria-label="Saved view"
            className={control}
            value={s.view ?? ''}
            onChange={(e) => {
              const v = s.views.find((x) => x.name === e.target.value);
              commit(v ? { ...s, ...cleanLayout(v.layout), view: v.name } : { ...s, view: null });
            }}
          >
            <option value="">No saved view</option>
            {s.views.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <LayoutMenu
          uid={uid}
          ordered={ordered}
          state={s}
          visibleCount={visible.length}
          onPatch={patch}
          onCommit={commit}
        />
        <button type="button" className={toolButton} onClick={exportXlsx}>
          <FileSpreadsheet className="size-3.5" aria-hidden /> Export to Excel
        </button>
      </div>
      <div className="-mx-5 overflow-x-auto">
        <table
          aria-label={label}
          data-density={s.density}
          className={cx(
            'table-fixed border-separate border-spacing-0 text-left text-sm',
            '[&_td]:px-3 [&_th]:px-3 [&_td:first-child]:pl-5 [&_th:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:last-child]:pr-5',
            '[&_th]:pb-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-fg-muted [&_td]:border-t [&_td]:border-line [&_td]:align-top',
            s.density === 'compact' ? '[&_td]:py-1' : '[&_td]:py-2.5',
          )}
          style={{ width: total, minWidth: '100%' }}
        >
          <colgroup>
            {visible.map((c) => (
              <col key={c.id} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visible.map((c, i) => {
                const sortable = isSortable(c);
                const dir = s.sort?.id === c.id ? s.sort.dir : null;
                const name = nameOf(c);
                const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={
                      sortable
                        ? dir === 'asc'
                          ? 'ascending'
                          : dir === 'desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                    style={sticky(i, true)}
                    className={cx(
                      'relative bg-surface align-bottom',
                      c.align === 'right' && 'text-right',
                      i === frozen - 1 && 'border-r border-line',
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c)}
                        className="group inline-flex max-w-full items-center gap-1 rounded text-left hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <span className="truncate">{c.header}</span>
                        <Icon
                          className={cx(
                            'size-3 shrink-0',
                            dir ? 'text-fg' : 'opacity-40 group-hover:opacity-100',
                          )}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      c.header
                    )}
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${name}`}
                      aria-valuenow={widthOf(c)}
                      aria-valuemin={MIN_WIDTH}
                      aria-valuemax={MAX_WIDTH}
                      tabIndex={0}
                      onPointerDown={(e) => startResize(c, e)}
                      onKeyDown={(e) => resizeKey(c, e)}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:outline-none"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody aria-label={label}>
            {sorted.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                // A clickable row is reachable by keyboard too: Tab to it, Enter opens it (step 9a.8).
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(r);
                      }
                    : undefined
                }
                className={cx(onRowClick && 'cursor-pointer hover:bg-surface-2')}
              >
                {visible.map((c, i) => (
                  <td
                    key={c.id}
                    style={sticky(i)}
                    className={cx(
                      'break-words',
                      c.align === 'right' && 'text-right tabular-nums',
                      i < frozen && 'bg-surface',
                      i === frozen - 1 && 'border-r',
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The "Columns" disclosure: show, order, freeze, density and saved views. */
function LayoutMenu<T>({
  uid,
  ordered,
  state: s,
  visibleCount,
  onPatch,
  onCommit,
}: {
  uid: string;
  ordered: GridColumn<T>[];
  state: GridState;
  visibleCount: number;
  onPatch: (p: Partial<GridLayout>) => void;
  onCommit: (s: GridState | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const refocus = useRef<string | null>(null);
  const panelId = `${uid}-layout`;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Moving a column re-renders the list; keep focus on the button that moved it, or its pair at the end of the list.
  useLayoutEffect(() => {
    const want = refocus.current;
    const root = wrap.current;
    if (!want || !root) return;
    refocus.current = null;
    const [colId, dir] = want.split('\u0000');
    const find = (d: string) =>
      [...root.querySelectorAll<HTMLButtonElement>(`[data-move="${d}"]`)].find(
        (b) => b.dataset.col === colId,
      );
    const b = find(dir!);
    (b && !b.disabled ? b : find(dir === 'up' ? 'down' : 'up'))?.focus();
  });

  const move = (i: number, by: -1 | 1) => {
    const order = ordered.map((c) => c.id);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    refocus.current = `${ordered[i]!.id}\u0000${by < 0 ? 'up' : 'down'}`;
    onPatch({ order });
  };

  const setShown = (colId: string, show: boolean) =>
    onPatch({
      hidden: show ? s.hidden.filter((h) => h !== colId) : [...s.hidden, colId],
    });

  const saveView = () => {
    const name = viewName.trim().slice(0, 60);
    if (!name) return;
    const views = [...s.views.filter((v) => v.name !== name), { name, layout: layoutOf(s) }].slice(
      -20,
    );
    onCommit({ ...s, views, view: name });
    setViewName('');
  };

  return (
    <div
      ref={wrap}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className={toolButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <Columns3 className="size-3.5" aria-hidden /> Columns
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Columns and layout"
          className="absolute right-0 z-20 mt-1 w-72 space-y-4 rounded-md border border-line bg-surface p-3 text-sm text-fg shadow-lg"
        >
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-fg-muted">Show and order</legend>
            <ul className="space-y-0.5">
              {ordered.map((c, i) => {
                const name = nameOf(c);
                const shown = c.hideable === false || !s.hidden.includes(c.id);
                return (
                  <li key={c.id} className="flex items-center gap-1">
                    <label className="flex min-w-0 flex-1 items-center gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={shown}
                        disabled={c.hideable === false || (shown && visibleCount <= 1)}
                        onChange={(e) => setShown(c.id, e.target.checked)}
                      />
                      <span className="truncate">{name}</span>
                    </label>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${name} up`}
                      data-move="up"
                      data-col={c.id}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ChevronUp className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${name} down`}
                      data-move="down"
                      data-col={c.id}
                      disabled={i === ordered.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ChevronDown className="size-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <label className="flex items-center justify-between gap-2">
            <span>Freeze columns</span>
            <select
              className={control}
              value={s.frozen}
              onChange={(e) => onPatch({ frozen: Number(e.target.value) })}
            >
              <option value={0}>None</option>
              <option value={1}>First column</option>
              <option value={2}>First 2 columns</option>
              <option value={3}>First 3 columns</option>
            </select>
          </label>
          <fieldset className="flex items-center justify-between gap-2">
            <legend className="float-left">Density</legend>
            <span className="flex gap-3">
              {(['comfortable', 'compact'] as const).map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${uid}-density`}
                    checked={s.density === d}
                    onChange={() => onPatch({ density: d })}
                  />
                  {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                </label>
              ))}
            </span>
          </fieldset>
          <div className="space-y-2 border-t border-line pt-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveView();
              }}
            >
              <input
                aria-label="View name"
                placeholder="Name this layout"
                className={cx(control, 'min-w-0 flex-1')}
                value={viewName}
                maxLength={60}
                onChange={(e) => setViewName(e.target.value)}
              />
              <button type="submit" className={toolButton} disabled={!viewName.trim()}>
                Save view
              </button>
            </form>
            <div className="flex flex-wrap gap-2">
              {s.view && (
                <button
                  type="button"
                  className={toolButton}
                  onClick={() =>
                    onCommit({ ...s, views: s.views.filter((v) => v.name !== s.view), view: null })
                  }
                >
                  Delete view {s.view}
                </button>
              )}
              <button
                type="button"
                className={toolButton}
                onClick={() =>
                  onCommit(
                    s.views.length ? { ...DEFAULT_LAYOUT, views: s.views, view: null } : null,
                  )
                }
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
