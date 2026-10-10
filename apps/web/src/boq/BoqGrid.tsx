// The BOQ grid (docs/wave1-plan.md step 3): a tree grid over a server-side sliding window.
//
// - Only the rows on screen are rendered; at most MAX_ROWS are held in memory. Scrolling near either end reads the
//   next window from the API; jumping (outline, search, Home/End) re-opens the window at a line.
// - Edits are saved one batch at a time, in order. The server answers with the edited line and its ancestors, so
//   section totals shown are always the stored ones.
// - Structural changes (move, indent, delete) re-open the window around the affected line.
import { SUBTREE_END } from '@aerolith/shared';
import { Alert, Button } from '@aerolith/ui';
import {
  Calculator,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownRight,
  FilePlus2,
  FolderPlus,
  IndentDecrease,
  IndentIncrease,
  ListChecks,
  MoveDown,
  MoveUp,
  Ruler,
  StickyNote,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
} from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { BulkEditDialog } from './BulkEdit';
import { load, save } from '../lib/storage';
import {
  COLUMNS,
  appendRows,
  editValue,
  formatAmount,
  formatQty,
  formatRate,
  insertTarget,
  mergeChanges,
  parseClipboard,
  parseDecimal,
  parseForeignRate,
  prependRows,
  type BoqHeader,
  type BoqRow,
  type Changes,
  type EditableColumn,
  type NodeType,
  type Slice,
  itemValue,
  KIND_BADGE,
  KIND_LABEL,
  type ItemKind,
} from './model';

const ROW_H = 32;
/** The column header is sticky inside the scroll area, so it scrolls sideways with the rows. */
const HEADER_H = 36;
const PAGE = 200;
const BEFORE = 100;
const OVERSCAN = 10;
const MAX_COLLAPSED = 1000;
const PASTE_LIMIT = 5000;
const GRID_COLUMNS = 'grid-cols-[5.5rem_minmax(12rem,1fr)_4.5rem_7rem_7rem_9rem]';
// Amount stays visible when the grid scrolls sideways on narrow screens.
const STICKY_AMOUNT = 'sticky right-0 z-[1] border-l border-line';

type Op = Record<string, unknown> & { op: string };
type Undo =
  | { kind: 'edit'; id: string; col: EditableColumn; prev: string | null }
  | { kind: 'insert'; id: string };

export interface GridHandle {
  /** Opens the grid at the line with this sort key, expanding any collapsed section above it. */
  jumpTo(sortKey: string): void;
  /** The line as the grid knows it now (with the newest row version). */
  row(id: string): BoqRow | undefined;
  /** Merges rows changed outside the grid (a measurement sheet saved) and the new BOQ header. */
  apply(rows: BoqRow[], header: BoqHeader): void;
}

interface Props {
  boqId: string;
  canEdit: boolean;
  onHeader: (h: BoqHeader) => void;
  onSaving: (pending: number) => void;
  /** Opens the item's measurement sheet. */
  onMeasure?: ((row: BoqRow) => void) | undefined;
  /** Asks the user for a rate analysis for this item; resolves to its id, or null when cancelled. */
  onPickAnalysis?: ((row: BoqRow) => Promise<string | null>) | undefined;
  /** A bulk change was made on the server: the grid and the header need reading again. */
  onBulkDone?: (() => void) | undefined;
}

/** A range of lines by sort key (Shift+click): `to`'s subtree is in it, so a section brings its contents. */
interface Selection {
  anchor: string;
  to: string;
}
const inSelection = (s: Selection | null, key: string) => {
  if (!s) return false;
  const [lo, hi] = s.anchor <= s.to ? [s.anchor, s.to] : [s.to, s.anchor];
  return key >= lo && key < hi + SUBTREE_END;
};

const editable = (row: BoqRow, col: EditableColumn) =>
  row.type === 'item' || col === 'description' || (col === 'code' && row.type === 'section');

export const BoqGrid = forwardRef<GridHandle, Props>(function BoqGrid(
  { boqId, canEdit, onHeader, onSaving, onPickAnalysis, onMeasure, onBulkDone },
  ref,
) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const storageKey = `aerolith.boq.${boqId}.collapsed`;
  const [slice, setSlice] = useState<Slice>({ rows: [], hasBefore: false, hasAfter: false });
  const [collapsed, setCollapsed] = useState<Map<string, string>>(() => {
    try {
      return new Map(JSON.parse(load(storageKey) ?? '[]') as [string, string][]);
    } catch {
      return new Map();
    }
  });
  const [active, setActive] = useState<{ id: string; col: EditableColumn } | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    col: EditableColumn;
    value: string;
    error?: string;
  } | null>(null);
  // The editor being committed by Enter/Tab/Escape must not be committed again by the blur that follows.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BoqRow | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [loaded, setLoaded] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const sliceRef = useRef(slice);
  sliceRef.current = slice;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const loading = useRef(false);
  const pendingScroll = useRef<{ delta: number } | { index: number; offset: number } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  /**
   * Row versions from save responses. The next queued batch can start before React re-renders with the merged rows,
   * so batches read versions from here first; otherwise quick consecutive edits of one line conflict with themselves.
   */
  const versions = useRef(new Map<string, number>());
  const undoStack = useRef<Undo[]>([]);

  const rows = slice.rows;
  const activeIndex = active ? rows.findIndex((r) => r.id === active.id) : -1;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

  // --- reading ---

  const fetchWindow = useCallback(
    async (params: Record<string, string>) => {
      const qs = new URLSearchParams(params);
      const ids = [...collapsedRef.current.keys()];
      if (ids.length) qs.set('collapsed', ids.join(','));
      return api.request<{ rows: BoqRow[]; hasMore: boolean }>(
        `/api/tenant/boqs/${boqId}/rows?${qs}`,
      );
    },
    [boqId],
  );

  /** Re-reads the window: at the start, at the end, or with the line at `key` placed `offset` px from the top. */
  const open = useCallback(
    async (at: { key?: string; end?: boolean; offset?: number } = {}) => {
      loading.current = true;
      try {
        if (at.end) {
          const page = await fetchWindow({ end: 'true', limit: String(PAGE) });
          setSlice({ rows: page.rows, hasBefore: page.hasMore, hasAfter: false });
          pendingScroll.current = { index: page.rows.length, offset: viewH };
          return page.rows;
        }
        if (at.key) {
          const [before, from] = await Promise.all([
            fetchWindow({ before: at.key, limit: String(BEFORE) }),
            fetchWindow({ from: at.key, limit: String(PAGE) }),
          ]);
          const all = before.rows.concat(from.rows);
          setSlice({ rows: all, hasBefore: before.hasMore, hasAfter: from.hasMore });
          pendingScroll.current = { index: before.rows.length, offset: at.offset ?? ROW_H * 3 };
          return from.rows;
        }
        const page = await fetchWindow({ limit: String(PAGE) });
        setSlice({ rows: page.rows, hasBefore: false, hasAfter: page.hasMore });
        pendingScroll.current = { index: 0, offset: 0 };
        return page.rows;
      } catch (err) {
        setError(describeError(err));
        return [];
      } finally {
        loading.current = false;
        setLoaded(true);
      }
    },
    [fetchWindow, viewH],
  );

  const firstVisible = useCallback((): { key: string; offset: number } | null => {
    const el = scroller.current;
    const s = sliceRef.current;
    if (!el || s.rows.length === 0) return null;
    const i = Math.min(s.rows.length - 1, Math.floor(el.scrollTop / ROW_H));
    return { key: s.rows[i]!.sortKey, offset: i * ROW_H - el.scrollTop };
  }, []);

  const offsetOf = (id: string) => {
    const i = sliceRef.current.rows.findIndex((r) => r.id === id);
    return i < 0 ? ROW_H * 3 : i * ROW_H - (scroller.current?.scrollTop ?? 0);
  };

  useEffect(() => {
    void open();
    // Only when the BOQ changes; later re-opens are explicit.
  }, [boqId]);

  const loadMore = useCallback(
    async (dir: 'before' | 'after') => {
      const s = sliceRef.current;
      if (loading.current || s.rows.length === 0) return;
      if (dir === 'after' ? !s.hasAfter : !s.hasBefore) return;
      loading.current = true;
      try {
        if (dir === 'after') {
          const page = await fetchWindow({ after: s.rows.at(-1)!.sortKey, limit: String(PAGE) });
          const { slice: next, droppedTop } = appendRows(sliceRef.current, page.rows, page.hasMore);
          pendingScroll.current = { delta: -droppedTop };
          setSlice(next);
        } else {
          const page = await fetchWindow({ before: s.rows[0]!.sortKey, limit: String(PAGE) });
          pendingScroll.current = { delta: page.rows.length };
          setSlice(prependRows(sliceRef.current, page.rows, page.hasMore));
        }
      } catch (err) {
        setError(describeError(err));
      } finally {
        loading.current = false;
      }
    },
    [fetchWindow],
  );

  // Keep the same lines on screen when rows are added or dropped above them, and place re-opened windows.
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pendingScroll.current;
    if (!el || !p) return;
    pendingScroll.current = null;
    if ('delta' in p) el.scrollTop += p.delta * ROW_H;
    else el.scrollTop = Math.max(0, p.index * ROW_H - p.offset);
    setScrollTop(el.scrollTop);
  }, [slice]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight - HEADER_H));
    ro.observe(el);
    setViewH(el.clientHeight - HEADER_H);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    setScrollTop(el.scrollTop);
    const first = Math.floor(el.scrollTop / ROW_H);
    const last = Math.ceil((el.scrollTop + el.clientHeight - HEADER_H) / ROW_H);
    if (last > sliceRef.current.rows.length - 60) void loadMore('after');
    else if (first < 60) void loadMore('before');
  };

  // --- saving ---

  /** Queues a batch; `build` runs when it is this batch's turn, so it sees the latest row versions. */
  const enqueue = useCallback(
    (build: () => Op[] | null, after?: (c: Changes) => Promise<void> | void) => {
      const task = queue.current.then(async () => {
        const ops = build();
        if (!ops || ops.length === 0) return;
        pending.current++;
        onSaving(pending.current);
        try {
          const changes = await api.request<Changes>(`/api/tenant/boqs/${boqId}/changes`, {
            method: 'POST',
            body: { ops },
          });
          for (const r of changes.rows) versions.current.set(r.id, r.rowVersion);
          onHeader(changes.header);
          if (!changes.reload)
            setSlice((s) =>
              mergeChanges(
                s,
                changes.rows,
                changes.deletedIds,
                new Set(collapsedRef.current.values()),
              ),
            );
          await after?.(changes);
        } catch (err) {
          setError(describeError(err));
          undoStack.current = [];
          const at = firstVisible();
          await open(at ? { key: at.key, offset: at.offset } : {});
        } finally {
          pending.current--;
          onSaving(pending.current);
        }
      });
      queue.current = task.catch(() => undefined);
      return task;
    },
    [boqId, onHeader, onSaving, open, firstVisible],
  );

  const rowById = (id: string) => {
    const row = sliceRef.current.rows.find((r) => r.id === id);
    const v = versions.current.get(id);
    return row && v !== undefined && v > row.rowVersion ? { ...row, rowVersion: v } : row;
  };

  /** Saves one cell. Returns false (and keeps the editor open) when the value is not valid. */
  const commitCell = (id: string, col: EditableColumn, input: string, record = true): boolean => {
    const row = rowById(id);
    if (!row || !editable(row, col)) return true;
    let value: string | null;
    // A rate in another currency ("USD 1200"): the server works out the rupee rate at the BOQ's exchange rate.
    const foreign = col === 'rate' ? parseForeignRate(input) : null;
    if (foreign) {
      if ('error' in foreign) {
        setEditing({ id, col, value: input, error: foreign.error });
        return false;
      }
      if (row.currency === foreign.currency && Number(row.foreignRate) === Number(foreign.value))
        return true;
      if (record) undoStack.current.push({ kind: 'edit', id, col, prev: row.rate });
      void enqueue(() => {
        const current = rowById(id);
        return current
          ? [
              {
                op: 'update',
                id,
                rowVersion: current.rowVersion,
                foreignRate: foreign.value,
                currency: foreign.currency,
              },
            ]
          : null;
      });
      return true;
    }
    if (col === 'qty' || col === 'rate') {
      const parsed = parseDecimal(input);
      if ('error' in parsed) {
        setEditing({ id, col, value: input, error: parsed.error });
        return false;
      }
      value = parsed.value;
    } else if (col === 'description') value = input;
    else value = input.trim() === '' ? null : input.trim();
    const prev = row[col];
    const same =
      col === 'qty' || col === 'rate'
        ? prev === value || (prev !== null && value !== null && Number(prev) === Number(value))
        : (prev ?? '') === (value ?? '');
    if (same) return true;
    if (record) undoStack.current.push({ kind: 'edit', id, col, prev });
    setSlice((s) => ({
      ...s,
      rows: s.rows.map((r) =>
        r.id === id ? { ...r, [col]: value ?? (col === 'description' ? '' : null) } : r,
      ),
    }));
    void enqueue(() => {
      const current = rowById(id);
      return current
        ? [
            {
              op: 'update',
              id,
              rowVersion: current.rowVersion,
              [col]: value ?? (col === 'description' ? '' : null),
            },
          ]
        : null;
    });
    return true;
  };

  /** Takes the active item's rate (and an empty unit or description) from a rate analysis the user picks. */
  const rateFromAnalysis = async () => {
    const row = activeRow;
    if (!row || row.type !== 'item' || !onPickAnalysis) return;
    const analysisId = await onPickAnalysis(row);
    scroller.current?.focus();
    if (!analysisId) return;
    void enqueue(() => {
      const current = rowById(row.id);
      return current
        ? [{ op: 'update', id: row.id, rowVersion: current.rowVersion, rateAnalysisId: analysisId }]
        : null;
    });
  };

  const setKind = (kind: ItemKind) => {
    const row = activeRow;
    if (!row || row.type !== 'item' || (row.kind ?? 'normal') === kind) return;
    void enqueue(() => {
      const current = rowById(row.id);
      return current ? [{ op: 'update', id: row.id, rowVersion: current.rowVersion, kind }] : null;
    });
  };

  // --- structure ---

  const insert = (type: NodeType) => {
    const target = insertTarget(activeRow, activeRow ? collapsed.has(activeRow.id) : false);
    void enqueue(
      () => [{ op: 'insert', tempId: 'tnew', type, ...target }],
      (c) => {
        const id = c.idMap.tnew;
        if (!id) return;
        undoStack.current.push({ kind: 'insert', id });
        setActive({ id, col: 'description' });
        setEditing({ id, col: 'description', value: '' });
      },
    );
  };

  const shift = (direction: 'up' | 'down' | 'in' | 'out') => {
    if (!activeRow) return;
    const id = activeRow.id;
    const offset = offsetOf(id);
    void enqueue(
      () => {
        const current = rowById(id);
        return current ? [{ op: 'shift', id, rowVersion: current.rowVersion, direction }] : null;
      },
      async (c) => {
        const moved = c.rows.find((r) => r.id === id);
        await open(moved ? { key: moved.sortKey, offset } : {});
      },
    );
  };

  const remove = (row: BoqRow) => {
    setConfirmDelete(null);
    const offset = offsetOf(row.id);
    void enqueue(
      () => {
        const current = rowById(row.id);
        return current ? [{ op: 'delete', id: row.id, rowVersion: current.rowVersion }] : null;
      },
      async () => {
        undoStack.current = undoStack.current.filter((u) => u.id !== row.id);
        const rowsNow = await open({ key: row.sortKey, offset });
        setActive(rowsNow[0] ? { id: rowsNow[0].id, col: active?.col ?? 'description' } : null);
      },
    );
  };

  const undo = () => {
    const u = undoStack.current.pop();
    if (!u) return;
    if (u.kind === 'edit') {
      const row = rowById(u.id);
      if (!row) return;
      setActive({ id: u.id, col: u.col });
      commitCell(
        u.id,
        u.col,
        u.prev === null ? '' : editValue({ ...row, [u.col]: u.prev }, u.col),
        false,
      );
    } else {
      const row = rowById(u.id);
      if (row) remove(row);
    }
  };

  // --- collapse and navigation ---

  const persist = (m: Map<string, string>) => {
    setCollapsed(m);
    collapsedRef.current = m;
    save(storageKey, JSON.stringify([...m.entries()]));
  };

  const toggle = (row: BoqRow) => {
    if (row.type !== 'section' || row.childCount === 0) return;
    const m = new Map(collapsedRef.current);
    if (m.has(row.id)) m.delete(row.id);
    else if (m.size < MAX_COLLAPSED) m.set(row.id, row.sortKey);
    persist(m);
    void open({ key: row.sortKey, offset: offsetOf(row.id) });
  };

  const collapseAll = async () => {
    try {
      const top = await api.request<BoqRow[]>(`/api/tenant/boqs/${boqId}/outline?maxDepth=0`);
      persist(
        new Map(
          top
            .filter((r) => r.childCount > 0)
            .slice(0, MAX_COLLAPSED)
            .map((r) => [r.id, r.sortKey]),
        ),
      );
      await open();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const expandAll = () => {
    const at = firstVisible();
    persist(new Map());
    void open(at ? { key: at.key, offset: at.offset } : {});
  };

  useImperativeHandle(ref, () => ({
    jumpTo(key: string) {
      const m = new Map(collapsedRef.current);
      for (const [id, k] of m) if (key.startsWith(k + '!')) m.delete(id);
      if (m.size !== collapsedRef.current.size) persist(m);
      void open({ key, offset: ROW_H * 3 }).then((r) => {
        if (r[0]) setActive({ id: r[0].id, col: 'description' });
        scroller.current?.focus();
      });
    },
    row: (id: string) => rowById(id),
    apply(changed: BoqRow[], header: BoqHeader) {
      for (const r of changed) versions.current.set(r.id, r.rowVersion);
      onHeader(header);
      setSlice((s) => mergeChanges(s, changed, [], new Set(collapsedRef.current.values())));
    },
  }));

  const ensureVisible = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    // Row i sits at HEADER_H + i×ROW_H in the content; the sticky header covers the top HEADER_H of the view.
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (HEADER_H + top + ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = HEADER_H + top + ROW_H - el.clientHeight;
  };

  const moveActive = (dRow: number, dCol = 0) => {
    if (rows.length === 0) return;
    const i = activeIndex < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, activeIndex + dRow));
    const c = active ? COLUMNS.indexOf(active.col) : 1;
    const col = COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, c + dCol))]!;
    setActive({ id: rows[i]!.id, col });
    ensureVisible(i);
    if (i >= rows.length - 5) void loadMore('after');
    if (i <= 5) void loadMore('before');
  };

  const startEdit = (initial?: string) => {
    if (!canEdit || !activeRow || !active || !editable(activeRow, active.col)) return;
    // A measured quantity is the sheet's total: edit the sheet instead.
    if (active.col === 'qty' && activeRow.measured) {
      onMeasure?.(activeRow);
      return;
    }
    setEditing({
      id: activeRow.id,
      col: active.col,
      value: initial ?? editValue(activeRow, active.col),
    });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.key === 'Escape' && selection) {
      e.preventDefault();
      setSelection(null);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && e.shiftKey && canEdit) {
      const dir = { ArrowRight: 'in', ArrowLeft: 'out', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
      if (dir) {
        e.preventDefault();
        shift(dir as 'up' | 'down' | 'in' | 'out');
      }
      return;
    }
    if (mod && e.key === 'Enter' && canEdit) {
      e.preventDefault();
      insert(e.shiftKey ? 'section' : 'item');
      return;
    }
    if (mod && e.key.toLowerCase() === 'z' && canEdit) {
      e.preventDefault();
      undo();
      return;
    }
    if (mod && e.key === 'Delete' && canEdit && activeRow) {
      e.preventDefault();
      setConfirmDelete(activeRow);
      return;
    }
    if (mod && e.key === 'Home') {
      e.preventDefault();
      void open().then(
        (r) => r[0] && setActive({ id: r[0].id, col: active?.col ?? 'description' }),
      );
      return;
    }
    if (mod && e.key === 'End') {
      e.preventDefault();
      void open({ end: true }).then((r) => {
        const last = r.at(-1);
        if (last) setActive({ id: last.id, col: active?.col ?? 'description' });
      });
      return;
    }
    const pageRows = Math.max(1, Math.floor(viewH / ROW_H) - 1);
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageDown: [pageRows, 0],
      PageUp: [-pageRows, 0],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      moveActive(m[0], m[1]);
      return;
    }
    if (!activeRow) return;
    if (e.key === ' ' && activeRow.type === 'section' && active?.col === 'description') {
      e.preventDefault();
      toggle(activeRow);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit && active) {
      e.preventDefault();
      commitCell(activeRow.id, active.col, '');
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(e.key);
    }
  };

  const onEditorKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const current = editingRef.current;
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      editingRef.current = null;
      setEditing(null);
      scroller.current?.focus();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (!commitCell(current.id, current.col, current.value)) return;
      editingRef.current = null;
      setEditing(null);
      scroller.current?.focus();
      if (e.key === 'Enter') moveActive(e.shiftKey ? -1 : 1);
      else moveActive(0, e.shiftKey ? -1 : 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !canEdit) return;
    const grid = parseClipboard(e.clipboardData.getData('text/plain'));
    if (grid.length === 0) return;
    e.preventDefault();
    if (grid.length === 1 && grid[0]!.length === 1 && activeRow && active) {
      commitCell(activeRow.id, active.col, grid[0]![0]!);
      return;
    }
    if (grid.length > PASTE_LIMIT) {
      setError(
        `That is ${grid.length} lines. Paste up to ${PASTE_LIMIT}; larger BOQs go through Excel import.`,
      );
      return;
    }
    const start = COLUMNS.indexOf(active?.col ?? 'code');
    let skipped = 0;
    const lines = grid.map((cells) => {
      const fields: Record<string, string | null> = {};
      cells.forEach((cell, j) => {
        const col = COLUMNS[start + j];
        if (!col) return;
        if (col === 'qty' || col === 'rate') {
          const p = parseDecimal(cell);
          if ('error' in p) skipped++;
          fields[col] = 'error' in p ? null : p.value;
        } else fields[col] = col === 'description' ? cell : cell.trim() || null;
      });
      return fields;
    });
    const target = insertTarget(activeRow, activeRow ? collapsed.has(activeRow.id) : false);
    let afterId = target.afterId;
    let firstId: string | null = null;
    for (let from = 0; from < lines.length; from += 500) {
      const chunk = lines.slice(from, from + 500);
      void enqueue(
        () =>
          chunk.map((f, k) => ({
            op: 'insert',
            tempId: `tp${k}`,
            type: 'item',
            parentId: target.parentId,
            afterId: k === 0 ? afterId : `tp${k - 1}`,
            ...f,
          })),
        async (c) => {
          afterId = c.idMap[`tp${chunk.length - 1}`] ?? afterId;
          firstId ??= c.idMap.tp0 ?? null;
          if (from + 500 >= lines.length) {
            const first = c.rows.find((r) => r.id === firstId) ?? c.rows[0];
            await open(
              first ? { key: first.sortKey, offset: offsetOf(activeRow?.id ?? '') + ROW_H } : {},
            );
            setInfo(
              `Pasted ${lines.length} line${lines.length === 1 ? '' : 's'}.` +
                (skipped
                  ? ` ${skipped} quantity or rate value(s) were not numbers and were left empty.`
                  : ''),
            );
          }
        },
      );
    }
  };

  // --- rendering ---

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  const cell = (
    row: BoqRow,
    col: EditableColumn | 'amount',
    content: React.ReactNode,
    extra = '',
  ) => {
    const isActive = active?.id === row.id && active.col === col;
    const isEditing = editing?.id === row.id && editing.col === col;
    return (
      <div
        role="gridcell"
        aria-selected={isActive}
        data-col={col}
        className={`relative flex h-full min-w-0 items-center border-r border-line px-2 ${extra} ${isActive ? 'outline-2 -outline-offset-2 outline-accent' : ''}`}
        onMouseDown={(e) => {
          if (isEditing) return;
          e.preventDefault();
          scroller.current?.focus();
          // Shift+click: select the lines from the active one to this one (for a bulk change).
          if (e.shiftKey && canEdit && activeRow) {
            setSelection({ anchor: activeRow.sortKey, to: row.sortKey });
            return;
          }
          setSelection(null);
          if (col === 'amount') return;
          setActive({ id: row.id, col });
        }}
        onDoubleClick={() => {
          if (col === 'amount' || !canEdit || !editable(row, col)) return;
          setActive({ id: row.id, col });
          if (col === 'qty' && row.measured) {
            onMeasure?.(row);
            return;
          }
          setEditing({ id: row.id, col, value: editValue(row, col) });
        }}
      >
        {isEditing ? (
          <>
            <input
              autoFocus
              aria-label={`Edit ${col}`}
              className={`absolute inset-0 w-full bg-surface px-2 text-sm outline-2 outline-accent ${col === 'qty' || col === 'rate' ? 'text-right tabular-nums' : ''}`}
              value={editing.value}
              onChange={(e) =>
                setEditing({ id: editing.id, col: editing.col, value: e.target.value })
              }
              onKeyDown={onEditorKey}
              onBlur={() => {
                const current = editingRef.current;
                if (!current) return;
                if (commitCell(current.id, current.col, current.value)) {
                  editingRef.current = null;
                  setEditing(null);
                }
              }}
            />
            {editing.error && (
              <span
                role="alert"
                className="absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-danger px-2 py-1 text-xs text-white"
              >
                {editing.error}
              </span>
            )}
          </>
        ) : (
          content
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      {bulkOpen && selection && (
        <BulkEditDialog
          boqId={boqId}
          selection={selection}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            setSelection(null);
            onBulkDone?.();
          }}
        />
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="BOQ editing">
          <Button
            variant="secondary"
            onClick={() => insert('item')}
            title="Add item below (Ctrl+Enter)"
          >
            <FilePlus2 className="size-4" aria-hidden /> Item
          </Button>
          <Button
            variant="secondary"
            onClick={() => insert('section')}
            title="Add section below (Ctrl+Shift+Enter)"
          >
            <FolderPlus className="size-4" aria-hidden /> Section
          </Button>
          <Button variant="ghost" onClick={() => insert('note')} title="Add a note line">
            <StickyNote className="size-4" aria-hidden /> Note
          </Button>
          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <Button
            variant="ghost"
            onClick={() => shift('out')}
            disabled={!activeRow}
            title="Outdent (Alt+Shift+←)"
            aria-label="Outdent"
          >
            <IndentDecrease className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={() => shift('in')}
            disabled={!activeRow}
            title="Indent into the section above (Alt+Shift+→)"
            aria-label="Indent"
          >
            <IndentIncrease className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={() => shift('up')}
            disabled={!activeRow}
            title="Move up (Alt+Shift+↑)"
            aria-label="Move up"
          >
            <MoveUp className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={() => shift('down')}
            disabled={!activeRow}
            title="Move down (Alt+Shift+↓)"
            aria-label="Move down"
          >
            <MoveDown className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={() => activeRow && setConfirmDelete(activeRow)}
            disabled={!activeRow}
            title="Delete line (Ctrl+Delete)"
            aria-label="Delete line"
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
          {onMeasure && (
            <Button
              variant="ghost"
              onClick={() => activeRow && onMeasure(activeRow)}
              disabled={activeRow?.type !== 'item'}
              title="Measurement sheet: the quantity from nos × L × B × H rows"
              aria-label="Measurement sheet"
            >
              <Ruler className="size-4" aria-hidden />
            </Button>
          )}
          {onPickAnalysis && (
            <Button
              variant="ghost"
              onClick={() => void rateFromAnalysis()}
              disabled={activeRow?.type !== 'item'}
              title="Take this item's rate from a rate analysis"
              aria-label="Rate from analysis"
            >
              <Calculator className="size-4" aria-hidden />
            </Button>
          )}
          <select
            aria-label="Kind of item"
            title="Provisional sums count in the total but take no markups; rate-only items and alternates are priced but not counted"
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50"
            disabled={activeRow?.type !== 'item'}
            value={activeRow?.type === 'item' ? (activeRow.kind ?? 'normal') : 'normal'}
            onChange={(e) => setKind(e.target.value as ItemKind)}
          >
            {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {selection ? (
            <>
              <Button variant="secondary" onClick={() => setBulkOpen(true)}>
                <ListChecks className="size-4" aria-hidden /> Bulk edit
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSelection(null)}
                title="Clear the selection (Esc)"
              >
                Clear selection
              </Button>
            </>
          ) : (
            <span className="px-1 text-xs text-fg-subtle">Shift+click to select lines</span>
          )}
          <Button variant="ghost" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Undo2 className="size-4" aria-hidden />
          </Button>
          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <Button
            variant="ghost"
            onClick={() => void collapseAll()}
            title="Collapse all sections"
            aria-label="Collapse all sections"
          >
            <ChevronsDownUp className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={expandAll}
            title="Expand all sections"
            aria-label="Expand all sections"
          >
            <ChevronsUpDown className="size-4" aria-hidden />
          </Button>
        </div>
      )}
      {!canEdit && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            onClick={() => void collapseAll()}
            aria-label="Collapse all sections"
            title="Collapse all sections"
          >
            <ChevronsDownUp className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={expandAll}
            aria-label="Expand all sections"
            title="Expand all sections"
          >
            <ChevronsUpDown className="size-4" aria-hidden />
          </Button>
        </div>
      )}
      {confirmDelete && (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Delete “{confirmDelete.description || confirmDelete.code || 'this line'}”
              {confirmDelete.type === 'section' && confirmDelete.childCount > 0
                ? ' and everything under it'
                : ''}
              ? This cannot be undone.
            </span>
            <Button variant="danger" onClick={() => remove(confirmDelete)}>
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep
            </Button>
          </div>
        </Alert>
      )}
      {error && (
        <Alert tone="danger">
          <span className="mr-3">{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </Alert>
      )}
      {info && (
        <Alert tone="success">
          <span className="mr-3">{info}</span>
          <button type="button" className="underline" onClick={() => setInfo(null)}>
            Dismiss
          </button>
        </Alert>
      )}

      <div className="flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <div
          ref={scroller}
          tabIndex={0}
          role="treegrid"
          aria-label="BOQ lines"
          aria-readonly={!canEdit}
          className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onScroll={onScroll}
          onKeyDown={onGridKey}
          onPaste={onPaste}
        >
          <div className="min-w-[45rem]">
            <div
              className={`sticky top-0 z-10 grid ${GRID_COLUMNS} items-center border-b border-line bg-surface-2 text-xs font-medium text-fg-muted [&>div]:px-2`}
              style={{ height: HEADER_H }}
              role="row"
            >
              <div role="columnheader">Code</div>
              <div role="columnheader">Description</div>
              <div role="columnheader">Unit</div>
              <div role="columnheader" className="text-right">
                Qty
              </div>
              <div role="columnheader" className="text-right">
                Rate
              </div>
              <div
                role="columnheader"
                className={`h-full bg-surface-2 text-right leading-[36px] ${STICKY_AMOUNT}`}
              >
                Amount
              </div>
            </div>
            <div className="relative" style={{ height: Math.max(rows.length * ROW_H, 1) }}>
              {visible.map((row, k) => {
                const i = first + k;
                const isSection = row.type === 'section';
                const isCollapsed = collapsed.has(row.id);
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-level={row.depth + 1}
                    aria-expanded={isSection && row.childCount > 0 ? !isCollapsed : undefined}
                    data-row-id={row.id}
                    aria-selected={inSelection(selection, row.sortKey) || undefined}
                    className={`absolute left-0 right-0 grid ${GRID_COLUMNS} border-b border-line text-sm ${isSection ? 'bg-surface-2/60 font-semibold' : ''} ${active?.id === row.id ? 'bg-accent/5' : ''} ${inSelection(selection, row.sortKey) ? '!bg-accent/15' : ''}`}
                    style={{ top: i * ROW_H, height: ROW_H }}
                  >
                    {cell(
                      row,
                      'code',
                      <span className="truncate font-mono text-xs">{row.code}</span>,
                    )}
                    {cell(
                      row,
                      'description',
                      <span
                        className="flex min-w-0 items-center"
                        style={{ paddingLeft: row.depth * 16 }}
                      >
                        {isSection && row.childCount > 0 ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                            className="mr-1 rounded p-0.5 text-fg-muted hover:bg-surface-3"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggle(row);
                            }}
                          >
                            {isCollapsed ? (
                              <ChevronRight className="size-4" aria-hidden />
                            ) : (
                              <ChevronDown className="size-4" aria-hidden />
                            )}
                          </button>
                        ) : (
                          <span
                            className="mr-1 inline-block w-5 shrink-0 text-fg-subtle"
                            aria-hidden
                          >
                            {row.type === 'note' ? (
                              ''
                            ) : isSection ? (
                              ''
                            ) : (
                              <CornerDownRight className="size-3" />
                            )}
                          </span>
                        )}
                        <span
                          className={`truncate ${row.type === 'note' ? 'italic text-fg-muted' : ''} ${!row.description ? 'text-fg-subtle' : ''}`}
                          title={row.description}
                        >
                          {row.description ||
                            (isSection ? 'Untitled section' : row.type === 'note' ? 'Note' : '')}
                        </span>
                        {row.type === 'item' && row.kind && KIND_BADGE[row.kind] && (
                          <span
                            className="ml-1.5 shrink-0 rounded bg-surface-3 px-1 text-[10px] font-semibold uppercase text-fg-muted"
                            title={KIND_LABEL[row.kind]}
                            data-testid="kind-badge"
                          >
                            {KIND_BADGE[row.kind]}
                          </span>
                        )}
                      </span>,
                    )}
                    {cell(row, 'unit', <span className="truncate">{row.unit}</span>)}
                    {cell(
                      row,
                      'qty',
                      <span className="flex w-full items-center justify-end gap-1 tabular-nums">
                        {row.measured && (
                          <Ruler className="size-3 shrink-0 text-accent" aria-label="Measured">
                            <title>From the measurement sheet</title>
                          </Ruler>
                        )}
                        {row.type === 'item' ? formatQty(row.qty) : ''}
                      </span>,
                    )}
                    {cell(
                      row,
                      'rate',
                      <span className="flex w-full items-center justify-end gap-1 tabular-nums">
                        {row.rateAnalysisId && (
                          <Calculator
                            className="size-3 shrink-0 text-accent"
                            aria-label="Rate from a rate analysis"
                          >
                            <title>Rate from a rate analysis</title>
                          </Calculator>
                        )}
                        {row.type === 'item' && row.currency && row.foreignRate && (
                          <span
                            className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-fg-muted"
                            title={`Priced in ${row.currency}; the rate follows the BOQ's exchange rate`}
                            data-testid="foreign-rate"
                          >
                            {row.currency} {formatRate(row.foreignRate)}
                          </span>
                        )}
                        {row.type === 'item' ? formatRate(row.rate) : ''}
                      </span>,
                    )}
                    {cell(
                      row,
                      'amount',
                      <span
                        className="w-full text-right tabular-nums"
                        data-testid={isSection ? `subtotal-${row.code ?? row.id}` : undefined}
                      >
                        {row.type === 'item' ? (
                          row.kind === 'alternate' ? (
                            <span
                              className="italic text-fg-subtle"
                              title="Alternate: its value is shown, but it is not in the total"
                            >
                              ({formatAmount(itemValue(row))})
                            </span>
                          ) : row.kind === 'rate_only' ? (
                            <span
                              className="text-xs text-fg-subtle"
                              title="Rate only: not in the total"
                            >
                              rate only
                            </span>
                          ) : (
                            formatAmount(row.amount)
                          )
                        ) : isSection ? (
                          formatAmount(row.subtotal)
                        ) : (
                          ''
                        )}
                      </span>,
                      'bg-surface-2/40',
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {loaded && rows.length === 0 && (
            <div className="absolute inset-x-0 top-16 text-center text-sm text-fg-muted">
              {canEdit
                ? 'Empty BOQ. Add a section or item above, or paste lines from Excel (Ctrl+V).'
                : 'This BOQ has no lines yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
