// The tender programme (docs/wave1-plan.md step 11): the Programme tab of a tender, the programme editor (activities
// grid beside the bar chart, recalculated on every change by the server) and its print view. A submission document:
// nothing here links to a live project.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Textarea,
  cx,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Diamond,
  IndentDecrease,
  IndentIncrease,
  Plus,
  Printer,
  Settings,
  Trash2,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api, ApiError } from '../api/client';
import { describeError, formatDate } from '../lib/format';
import { Gantt, HEAD_H, ROW_H, type Zoom } from '../schedule/Gantt';
import {
  CONSTRAINTS,
  MONTHS,
  WEEKDAYS,
  dayNo,
  parsePredecessors,
  predecessorOps,
  predecessorsText,
  shortDate,
  workWeekLabel,
  type ConstraintType,
  type Op,
  type ProgrammeActivity,
  type ProgrammeCalendar,
  type ProgrammeDetail,
  type ProgrammeSummary,
} from '../schedule/model';
import { usePermission } from '../session/permissions';

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// --- the tender's programmes ---

export function TenderProgrammes({ tenderId }: { tenderId: string }) {
  const navigate = useNavigate();
  const canEdit = usePermission('programme.edit');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('Submission programme');
  const [startOn, setStartOn] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['programmes', tenderId],
    queryFn: () => api.request<ProgrammeSummary[]>(`/api/tenant/tenders/${tenderId}/programmes`),
  });
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.request<ProgrammeDetail>(`/api/tenant/tenders/${tenderId}/programmes`, {
        method: 'POST',
        body: { name, startOn },
      });
      await navigate({ to: '/programmes/$planId', params: { planId: p.id } });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <Card
      title="Tender programme"
      actions={
        canEdit &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> New programme
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        The programme submitted with the bid: activities, links, calendars and the critical path. It
        is a document of the tender; winning does not turn it into a project schedule.
      </p>
      {adding && (
        <form
          onSubmit={(e) => void create(e)}
          className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-2 p-3"
        >
          <div className="min-w-[14rem] flex-1">
            <Field label="Programme name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </Field>
          </div>
          <Field label="Starts on" hint="The data date: nothing starts before it.">
            <Input
              type="date"
              value={startOn}
              onChange={(e) => setStartOn(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" busy={busy}>
            Create programme
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-sm text-fg-muted">No programme yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {list.data.map((p) => (
            <li
              key={p.id}
              className={cx(
                'flex items-center justify-between gap-3 py-2',
                p.archivedAt && 'opacity-60',
              )}
            >
              <span className="flex items-center gap-2">
                <Link
                  to="/programmes/$planId"
                  params={{ planId: p.id }}
                  className="font-medium text-accent hover:underline"
                >
                  {p.name}
                </Link>
                {p.archivedAt && <Badge>archived</Badge>}
              </span>
              <span className="text-right text-xs text-fg-muted">
                {formatDate(p.startOn)} to {p.finishOn ? formatDate(p.finishOn) : '-'}
                <span className="block">
                  {p.activityCount} activities · {p.duration ?? 0} working days
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- the editor ---

/** Runs edits one at a time (each answers with the recalculated plan) and shows what was refused and why. */
function usePlan(planId: string) {
  const qc = useQueryClient();
  const plan = useQuery({
    queryKey: ['programme', planId],
    queryFn: () => api.request<ProgrammeDetail>(`/api/tenant/programmes/${planId}`),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const store = (p: ProgrammeDetail) => {
    qc.setQueryData(['programme', planId], p);
    void qc.invalidateQueries({ queryKey: ['programmes', p.tenderId] });
  };
  const run = async (fn: (p: ProgrammeDetail) => Promise<ProgrammeDetail>) => {
    const p = qc.getQueryData<ProgrammeDetail>(['programme', planId]);
    if (!p) return false;
    setBusy(true);
    setError(null);
    try {
      store(await fn(p));
      return true;
    } catch (err) {
      const ids =
        err instanceof ApiError && Array.isArray(err.body.activities)
          ? (err.body.activities as string[])
          : [];
      setError(
        describeError(err) +
          (ids.length && !describeError(err).includes(ids[0]!) ? ` (${ids.join(', ')})` : ''),
      );
      if (err instanceof ApiError && err.code === 'stale_row') void plan.refetch();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (ops: Op[]) =>
    run(async (p) => {
      const r = await api.request<{ plan: ProgrammeDetail; idMap: Record<string, string> }>(
        `/api/tenant/programmes/${planId}/changes`,
        { method: 'POST', body: { rowVersion: p.rowVersion, ops } },
      );
      lastIdMap.current = r.idMap;
      return r.plan;
    });
  const lastIdMap = useRef<Record<string, string>>({});
  const post = (url: string, body: (p: ProgrammeDetail) => object) =>
    run((p) =>
      api.request<ProgrammeDetail>(`/api/tenant/programmes/${planId}${url}`, {
        method: 'POST',
        body: body(p),
      }),
    );
  return { plan, busy, error, setError, edit, post, lastIdMap };
}

/** A cell that turns into a text box on click; Enter or leaving it saves, Escape cancels. */
function Cell({
  value,
  onCommit,
  editable,
  label,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  editable: boolean;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <div
        role="gridcell"
        aria-label={label}
        tabIndex={editable ? 0 : -1}
        className={cx('truncate px-2 py-1', editable && 'cursor-text', className)}
        onClick={() => editable && setDraft(value)}
        onKeyDown={(e) => {
          if (editable && (e.key === 'Enter' || e.key === 'F2')) {
            e.preventDefault();
            setDraft(value);
          }
        }}
        title={value}
      >
        {value || ' '}
      </div>
    );
  const done = (save: boolean) => {
    if (save && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      autoFocus
      className={cx(
        'w-full rounded border border-accent bg-surface px-1.5 py-0.5 text-sm outline-none',
        className,
      )}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
        e.stopPropagation();
      }}
    />
  );
}

const COLS = 'grid-cols-[2.25rem_5rem_minmax(11rem,1fr)_3.25rem_5.25rem_5.25rem_7rem_3rem]';

export function ProgrammeScreen({ planId }: { planId: string }) {
  const canEditRole = usePermission('programme.edit');
  const { plan, busy, error, setError, edit, post, lastIdMap } = usePlan(planId);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<Zoom>('week');
  const [scrollTop, setScrollTop] = useState(0);
  const [panel, setPanel] = useState<'calendars' | 'settings' | null>(null);
  const gridBox = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(600);
  const tempSeq = useRef(0);

  const p = plan.data;
  const rows = useMemo(() => {
    if (!p) return [];
    const out: ProgrammeActivity[] = [];
    let hideBelow: number | null = null;
    for (const a of p.activities) {
      if (hideBelow !== null && a.depth > hideBelow) continue;
      hideBelow = null;
      out.push(a);
      if (collapsed.has(a.id)) hideBelow = a.depth;
    }
    return out;
  }, [p, collapsed]);
  const codeOf = useMemo(() => {
    const m = new Map(p?.activities.map((a) => [a.id, a.code]) ?? []);
    return (id: string) => m.get(id) ?? '?';
  }, [p]);

  useLayoutEffect(() => {
    const el = gridBox.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - scrollTop) > 1) el.scrollTop = scrollTop;
    setViewH(el.clientHeight);
  }, [scrollTop, rows.length]);

  useEffect(() => {
    if (p && selected && !p.activities.some((a) => a.id === selected)) setSelected(null);
  }, [p, selected]);

  if (plan.isPending) return <Spinner />;
  if (plan.isError) return <Alert tone="danger">{describeError(plan.error)}</Alert>;
  const d = plan.data;
  const canEdit = canEditRole && !d.archivedAt && !busy;
  const sel = d.activities.find((a) => a.id === selected) ?? null;
  const siblings = (parentId: string | null) => d.activities.filter((a) => a.parentId === parentId);
  const defaultCal = d.calendars.find((c) => c.id === d.calendarId);

  const add = (kind: 'task' | 'milestone') => {
    const tempId = `t${++tempSeq.current}`;
    const parentId = sel ? sel.parentId : null;
    const afterId = sel ? sel.id : (siblings(null).at(-1)?.id ?? null);
    void edit([
      {
        op: 'insert',
        tempId,
        parentId,
        afterId,
        name: kind === 'milestone' ? 'New milestone' : 'New activity',
        duration: kind === 'milestone' ? 0 : 1,
      },
    ]).then((ok) => ok && setSelected(lastIdMap.current[tempId] ?? null));
  };
  const indent = () => {
    if (!sel) return;
    const sibs = siblings(sel.parentId);
    const prev = sibs[sibs.findIndex((a) => a.id === sel.id) - 1];
    if (!prev) return;
    const kids = siblings(prev.id);
    void edit([{ op: 'move', id: sel.id, parentId: prev.id, afterId: kids.at(-1)?.id ?? null }]);
  };
  const outdent = () => {
    if (!sel?.parentId) return;
    const parent = d.activities.find((a) => a.id === sel.parentId)!;
    void edit([{ op: 'move', id: sel.id, parentId: parent.parentId, afterId: parent.id }]);
  };
  const shift = (dir: -1 | 1) => {
    if (!sel) return;
    const sibs = siblings(sel.parentId);
    const i = sibs.findIndex((a) => a.id === sel.id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    const afterId = dir === 1 ? sibs[j]!.id : (sibs[j - 1]?.id ?? null);
    void edit([{ op: 'move', id: sel.id, parentId: sel.parentId, afterId }]);
  };
  const remove = () => {
    if (!sel) return;
    const under = d.activities.filter((a) => a.parentId === sel.id).length;
    if (under && !window.confirm(`Delete ${sel.code} and everything under it?`)) return;
    void edit([{ op: 'delete', id: sel.id }]);
  };
  const setPreds = (a: ProgrammeActivity, text: string) => {
    const parsed = parsePredecessors(
      text,
      d.activities.map((x) => x.code),
    );
    if (parsed.errors.length) return setError(parsed.errors.join(' '));
    const ids = new Map(d.activities.map((x) => [x.code, x.id]));
    const ops = predecessorOps(a.id, parsed.links, d.links, (c) => ids.get(c)!);
    if (ops.length) void edit(ops);
  };
  const setDuration = (a: ProgrammeActivity, v: string) => {
    const n = Number(v.replace(/d$/i, '').trim());
    if (!Number.isInteger(n) || n < 0 || n > 36500)
      return setError('A duration is a whole number of working days.');
    void edit([{ op: 'update', id: a.id, duration: n }]);
  };

  // Timeline: a week before the start to two months after the finish.
  const from = dayNo(d.startOn) - 7;
  const to = Math.max(dayNo(d.finishOn ?? d.startOn), dayNo(d.startOn)) + 60;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 5);
  const onKey = (e: KeyboardEvent) => {
    if (!canEdit || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Insert') add('task');
    else if (e.key === 'Delete' && sel) remove();
    else if (e.altKey && e.shiftKey && e.key === 'ArrowRight') indent();
    else if (e.altKey && e.shiftKey && e.key === 'ArrowLeft') outdent();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = rows.findIndex((r) => r.id === selected);
      const next =
        rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setSelected(next.id);
      e.preventDefault();
    }
  };

  return (
    <div className="space-y-4">
      <Link
        to="/tenders/$tenderId"
        params={{ tenderId: d.tenderId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {d.tender.number} · {d.tender.title}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{d.name}</h1>
          <p className="mt-1 text-sm text-fg-muted" data-testid="programme-summary">
            {shortDate(d.startOn)} to {shortDate(d.finishOn)} · {d.duration ?? 0} working days ·{' '}
            {d.activityCount} activities{d.archivedAt && ' · archived'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setPanel(panel === 'calendars' ? null : 'calendars')}
          >
            <CalendarDays className="size-4" aria-hidden /> Calendars
          </Button>
          {canEditRole && (
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            >
              <Settings className="size-4" aria-hidden /> Settings
            </Button>
          )}
          <Link
            to="/programmes/$planId/print"
            params={{ planId }}
            target="_blank"
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3"
          >
            <Printer className="size-4" aria-hidden /> Print / PDF
          </Link>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {panel === 'settings' && (
        <SettingsPanel
          plan={d}
          busy={busy}
          onSave={(body) =>
            void post('', (x) => ({ rowVersion: x.rowVersion, ...body })).then(
              (ok) => ok && setPanel(null),
            )
          }
          onArchive={(archived) => void post('/archive', () => ({ archived }))}
        />
      )}
      {panel === 'calendars' && (
        <CalendarsPanel
          plan={d}
          canEdit={canEditRole && !d.archivedAt}
          busy={busy}
          onSave={(id, body) =>
            post(id ? `/calendars/${id}` : '/calendars', (x) => ({
              rowVersion: x.rowVersion,
              ...body,
            }))
          }
        />
      )}

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="toolbar"
        aria-label="Programme tools"
      >
        {canEditRole && (
          <>
            <Button variant="secondary" onClick={() => add('task')} disabled={!canEdit}>
              <Plus className="size-4" aria-hidden /> Activity
            </Button>
            <Button variant="secondary" onClick={() => add('milestone')} disabled={!canEdit}>
              <Diamond className="size-4" aria-hidden /> Milestone
            </Button>
            <Button
              variant="ghost"
              aria-label="Indent"
              title="Indent (Alt+Shift+→)"
              onClick={indent}
              disabled={!canEdit || !sel}
            >
              <IndentIncrease className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              aria-label="Outdent"
              title="Outdent (Alt+Shift+←)"
              onClick={outdent}
              disabled={!canEdit || !sel?.parentId}
            >
              <IndentDecrease className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              aria-label="Move up"
              onClick={() => shift(-1)}
              disabled={!canEdit || !sel}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              aria-label="Move down"
              onClick={() => shift(1)}
              disabled={!canEdit || !sel}
            >
              <ArrowDown className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              aria-label="Delete activity"
              onClick={remove}
              disabled={!canEdit || !sel}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          {busy && <span className="text-xs text-fg-muted">Recalculating…</span>}
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-fg-muted">
            <span className="inline-block h-2.5 w-4 rounded-sm bg-danger" /> critical
            <span className="ml-2 inline-block h-2.5 w-4 rounded-sm bg-info" /> with float
          </span>
          <Select
            aria-label="Zoom"
            className="w-28"
            value={zoom}
            onChange={(e) => setZoom(e.target.value as Zoom)}
          >
            <option value="day">Days</option>
            <option value="week">Weeks</option>
            <option value="month">Months</option>
          </Select>
        </div>
      </div>

      <div className="flex h-[calc(100vh-17rem)] min-h-[24rem] overflow-hidden rounded-lg border border-line bg-surface">
        <div
          ref={gridBox}
          className="relative w-[24rem] shrink-0 overflow-auto border-r border-line text-sm md:w-[30rem] 2xl:w-[42rem]"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKey}
          role="treegrid"
          aria-label="Programme activities"
          aria-rowcount={rows.length}
        >
          <div style={{ height: HEAD_H + rows.length * ROW_H + 40, minWidth: '42rem' }}>
            <div
              role="row"
              className={cx(
                'sticky top-0 z-10 grid items-end border-b border-line bg-surface pb-1.5 text-xs font-medium text-fg-muted',
                COLS,
              )}
              style={{ height: HEAD_H }}
            >
              {['#', 'ID', 'Activity', 'Days', 'Start', 'Finish', 'Predecessors', 'Float'].map(
                (h) => (
                  <div key={h} role="columnheader" className="px-2">
                    {h}
                  </div>
                ),
              )}
            </div>
            {rows.slice(first, last).map((a, k) => {
              const i = first + k;
              const isSel = a.id === selected;
              const summary = a.kind === 'summary';
              return (
                <div
                  key={a.id}
                  role="row"
                  aria-level={a.depth + 1}
                  aria-rowindex={i + 1}
                  aria-selected={isSel}
                  {...(summary ? { 'aria-expanded': !collapsed.has(a.id) } : {})}
                  className={cx(
                    'absolute left-0 right-0 grid items-center border-b border-line/60',
                    COLS,
                    isSel && 'bg-accent/10',
                    a.critical && !summary && 'text-danger',
                    summary && 'font-semibold',
                  )}
                  style={{ top: HEAD_H + i * ROW_H, height: ROW_H }}
                  onClick={() => setSelected(a.id)}
                >
                  <div role="gridcell" className="px-2 text-xs text-fg-subtle tabular-nums">
                    {i + 1}
                  </div>
                  <Cell
                    label={`ID of ${a.name}`}
                    value={a.code}
                    editable={canEdit}
                    onCommit={(v) => void edit([{ op: 'update', id: a.id, code: v }])}
                    className="font-mono text-xs"
                  />
                  <div className="flex min-w-0 items-center" style={{ paddingLeft: a.depth * 16 }}>
                    {summary ? (
                      <button
                        type="button"
                        aria-label={collapsed.has(a.id) ? `Expand ${a.name}` : `Collapse ${a.name}`}
                        className="shrink-0 text-fg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(collapsed);
                          if (next.has(a.id)) next.delete(a.id);
                          else next.add(a.id);
                          setCollapsed(next);
                        }}
                      >
                        {collapsed.has(a.id) ? (
                          <ChevronRight className="size-4" />
                        ) : (
                          <ChevronDown className="size-4" />
                        )}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <Cell
                        label={`Name of ${a.code}`}
                        value={a.name}
                        editable={canEdit}
                        onCommit={(v) => void edit([{ op: 'update', id: a.id, name: v }])}
                      />
                    </div>
                  </div>
                  <Cell
                    label={`Duration of ${a.code}`}
                    value={String(a.duration)}
                    editable={canEdit && !summary}
                    onCommit={(v) => setDuration(a, v)}
                    className="text-right tabular-nums"
                  />
                  <div role="gridcell" className="px-2 text-xs tabular-nums">
                    {shortDate(a.earlyStart)}
                  </div>
                  <div role="gridcell" className="px-2 text-xs tabular-nums">
                    {shortDate(a.earlyFinish)}
                  </div>
                  <Cell
                    label={`Predecessors of ${a.code}`}
                    value={summary ? '' : predecessorsText(a.id, d.links, codeOf)}
                    editable={canEdit && !summary}
                    onCommit={(v) => setPreds(a, v)}
                    className="font-mono text-xs"
                  />
                  <div role="gridcell" className="px-2 text-right text-xs tabular-nums">
                    {a.totalFloat ?? ''}
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <p
                className="absolute left-0 right-0 px-4 text-sm text-fg-muted"
                style={{ top: HEAD_H + 12 }}
              >
                No activities yet.{' '}
                {canEditRole &&
                  'Add the first with "Activity". A row with rows indented under it becomes a summary.'}
              </p>
            )}
          </div>
        </div>
        <Gantt
          rows={rows}
          links={d.links}
          calendar={defaultCal}
          dataDate={d.startOn}
          from={from}
          to={to}
          zoom={zoom}
          selectedId={selected}
          onSelect={setSelected}
          scrollTop={scrollTop}
          onScrollTop={setScrollTop}
        />
      </div>
      {sel && (
        <ActivityPanel
          key={`${sel.id}-${d.rowVersion}`}
          plan={d}
          activity={sel}
          canEdit={canEdit}
          onSave={(op) => void edit([op])}
        />
      )}
    </div>
  );
}

function ActivityPanel({
  plan,
  activity: a,
  canEdit,
  onSave,
}: {
  plan: ProgrammeDetail;
  activity: ProgrammeActivity;
  canEdit: boolean;
  onSave: (op: Op) => void;
}) {
  const [calendarId, setCalendarId] = useState(a.calendarId ?? '');
  const [ctype, setCtype] = useState<ConstraintType | ''>(a.constraintType ?? '');
  const [cdate, setCdate] = useState(a.constraintDate ?? '');
  const [notes, setNotes] = useState(a.notes);
  const summary = a.kind === 'summary';
  const save = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      op: 'update',
      id: a.id,
      calendarId: calendarId || null,
      constraint: ctype && cdate ? { type: ctype, date: cdate } : null,
      notes,
    });
  };
  return (
    <Card title={`${a.code} · ${a.name}`}>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <dl className="grid grid-cols-[8rem_1fr] content-start gap-y-1 text-sm">
          <dt className="text-fg-muted">Early dates</dt>
          <dd>
            {shortDate(a.earlyStart)} to {shortDate(a.earlyFinish)}
          </dd>
          <dt className="text-fg-muted">Late dates</dt>
          <dd>
            {shortDate(a.lateStart)} to {shortDate(a.lateFinish)}
          </dd>
          <dt className="text-fg-muted">Total float</dt>
          <dd>
            {a.totalFloat ?? '-'} working days{' '}
            {a.critical && !summary && <Badge tone="danger">critical</Badge>}
          </dd>
          <dt className="text-fg-muted">Free float</dt>
          <dd>{a.freeFloat ?? '-'} working days</dd>
        </dl>
        {!summary && (
          <form onSubmit={save} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Calendar">
                <Select
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                  disabled={!canEdit}
                >
                  <option value="">The programme's</option>
                  {plan.calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Constraint">
                <Select
                  value={ctype}
                  onChange={(e) => setCtype(e.target.value as ConstraintType | '')}
                  disabled={!canEdit}
                >
                  <option value="">None</option>
                  {Object.entries(CONSTRAINTS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Constraint date">
                <Input
                  type="date"
                  value={cdate}
                  onChange={(e) => setCdate(e.target.value)}
                  disabled={!canEdit || !ctype}
                />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!canEdit}
              />
            </Field>
            {canEdit && (
              <Button type="submit" variant="secondary" disabled={Boolean(ctype) && !cdate}>
                Save activity
              </Button>
            )}
          </form>
        )}
      </div>
    </Card>
  );
}

function SettingsPanel({
  plan,
  busy,
  onSave,
  onArchive,
}: {
  plan: ProgrammeDetail;
  busy: boolean;
  onSave: (body: { name: string; startOn: string; calendarId: string; notes: string }) => void;
  onArchive: (archived: boolean) => void;
}) {
  const [v, setV] = useState({
    name: plan.name,
    startOn: plan.startOn,
    calendarId: plan.calendarId,
    notes: plan.notes,
  });
  return (
    <Card title="Programme settings">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Programme name">
            <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
          </Field>
          <Field label="Data date" hint="Nothing starts before it.">
            <Input
              type="date"
              value={v.startOn}
              onChange={(e) => setV({ ...v, startOn: e.target.value })}
              required
            />
          </Field>
          <Field label="Default calendar">
            <Select
              value={v.calendarId}
              onChange={(e) => setV({ ...v, calendarId: e.target.value })}
            >
              {plan.calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea
            rows={2}
            value={v.notes}
            onChange={(e) => setV({ ...v, notes: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy}>
            Save and recalculate
          </Button>
          <Button type="button" variant="ghost" onClick={() => onArchive(!plan.archivedAt)}>
            {plan.archivedAt ? 'Restore programme' : 'Archive programme'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CalendarsPanel({
  plan,
  canEdit,
  busy,
  onSave,
}: {
  plan: ProgrammeDetail;
  canEdit: boolean;
  busy: boolean;
  onSave: (
    id: string | null,
    body: { name: string; workWeek: number; holidays: string[]; workingDays: string[] },
  ) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<ProgrammeCalendar | 'new' | null>(null);
  return (
    <Card title="Calendars">
      <p className="mb-3 text-sm text-fg-muted">
        Durations and lags count working days. Each activity follows the programme&apos;s default
        calendar unless it names another.
      </p>
      <Table>
        <thead>
          <tr>
            <th>Calendar</th>
            <th>Working days</th>
            <th>Holidays</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plan.calendars.map((c) => (
            <tr key={c.id}>
              <td className="font-medium">
                {c.name} {c.id === plan.calendarId && <Badge tone="accent">default</Badge>}
              </td>
              <td>{workWeekLabel(c.workWeek)}</td>
              <td>{c.holidays.length}</td>
              <td className="text-right">
                {canEdit && (
                  <Button variant="ghost" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {canEdit && !editing && (
        <Button variant="secondary" className="mt-3" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden /> Calendar
        </Button>
      )}
      {editing && (
        <CalendarForm
          key={editing === 'new' ? 'new' : editing.id}
          calendar={editing === 'new' ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(body) =>
            void onSave(editing === 'new' ? null : editing.id, body).then(
              (ok) => ok && setEditing(null),
            )
          }
        />
      )}
    </Card>
  );
}

function CalendarForm({
  calendar,
  busy,
  onSave,
  onCancel,
}: {
  calendar: ProgrammeCalendar | null;
  busy: boolean;
  onSave: (body: {
    name: string;
    workWeek: number;
    holidays: string[];
    workingDays: string[];
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(calendar?.name ?? '');
  const [week, setWeek] = useState(calendar?.workWeek ?? 0b0111111);
  const [holidays, setHolidays] = useState((calendar?.holidays ?? []).join('\n'));
  const [extra, setExtra] = useState((calendar?.workingDays ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const dates = (text: string) =>
    text
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bad = [...dates(holidays), ...dates(extra)].filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x));
    if (bad.length) return setError(`Write dates as YYYY-MM-DD: ${bad.slice(0, 3).join(', ')}`);
    onSave({ name, workWeek: week, holidays: dates(holidays), workingDays: dates(extra) });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-3 rounded-md border border-line bg-surface-2 p-3"
    >
      <Field label="Calendar name">
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Working days</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {WEEKDAYS.map((w, i) => (
            <label key={w} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={(week & (1 << i)) !== 0}
                onChange={() => setWeek(week ^ (1 << i))}
              />
              {w}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Holidays" hint="One date per line (YYYY-MM-DD).">
          <Textarea rows={5} value={holidays} onChange={(e) => setHolidays(e.target.value)} />
        </Field>
        <Field label="Extra working days" hint="Days off in the week that are worked.">
          <Textarea rows={5} value={extra} onChange={(e) => setExtra(e.target.value)} />
        </Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save and recalculate
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- print ---

const PAGE = { w: 1587, h: 1123 }; // A3 landscape at 96 dpi
const ROWS_PER_PAGE = 38;

/**
 * The programme on A3 landscape pages for printing or saving as PDF from the browser: a title block, the activity
 * table and the bars to one time scale across every page, and a legend. Drawn as SVG, so it prints sharp.
 */
export function ProgrammePrint({ planId }: { planId: string }) {
  const plan = useQuery({
    queryKey: ['programme', planId],
    queryFn: () => api.request<ProgrammeDetail>(`/api/tenant/programmes/${planId}`),
  });
  if (plan.isPending) return <Spinner />;
  if (plan.isError) return <Alert tone="danger">{describeError(plan.error)}</Alert>;
  const d = plan.data;
  const pages: ProgrammeActivity[][] = [];
  for (let i = 0; i < Math.max(1, d.activities.length); i += ROWS_PER_PAGE)
    pages.push(d.activities.slice(i, i + ROWS_PER_PAGE));
  const from = dayNo(d.startOn);
  const to = Math.max(dayNo(d.finishOn ?? d.startOn), from) + 1;
  return (
    <div className="bg-white text-black">
      <style>
        {
          '@page { size: A3 landscape; margin: 0 } @media print { .no-print { display: none } .page { break-after: page } }'
        }
      </style>
      <div className="no-print flex items-center gap-3 p-4">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print or save as PDF
        </Button>
        <span className="text-sm text-gray-600">
          {pages.length} page{pages.length === 1 ? '' : 's'}, A3 landscape. Choose &ldquo;Save as
          PDF&rdquo; as the printer for a PDF.
        </span>
      </div>
      {pages.map((rows, n) => (
        <PrintPage
          key={n}
          plan={d}
          rows={rows}
          page={n + 1}
          pages={pages.length}
          offset={n * ROWS_PER_PAGE}
          from={from}
          to={to}
        />
      ))}
    </div>
  );
}

function PrintPage({
  plan: d,
  rows,
  page,
  pages,
  offset,
  from,
  to,
}: {
  plan: ProgrammeDetail;
  rows: ProgrammeActivity[];
  page: number;
  pages: number;
  offset: number;
  from: number;
  to: number;
}) {
  const M = 30;
  const tableW = 640;
  const top = 110;
  const rowH = 24;
  const chartX = M + tableW;
  const chartW = PAGE.w - M - chartX;
  const scale = chartW / (to - from);
  const x = (day: number) => chartX + (day - from) * scale;
  // Days for a short programme, Mondays for a few months, months only beyond that.
  const span = to - from;
  const ticks: { day: number; label: string }[] = [];
  for (let day = from; day <= to && span <= 200; day++) {
    const dow = (((day + 3) % 7) + 7) % 7;
    if (span <= 45 || dow === 0)
      ticks.push({
        day,
        label: String(Number(new Date(day * 86_400_000).toISOString().slice(8, 10))),
      });
  }
  const months: { day: number; label: string }[] = [];
  for (let day = from; day <= to; day++) {
    const iso = new Date(day * 86_400_000).toISOString().slice(0, 10);
    if (day === from || iso.endsWith('-01'))
      months.push({ day, label: `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}` });
  }
  const cols = [
    { label: 'ID', x: M + 4, w: 70 },
    { label: 'Activity', x: M + 78, w: 330 },
    { label: 'Days', x: M + 412, w: 40 },
    { label: 'Start', x: M + 456, w: 90 },
    { label: 'Finish', x: M + 548, w: 90 },
  ];
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return (
    <svg
      className="page mx-auto block h-auto w-full"
      style={{ maxWidth: PAGE.w }}
      viewBox={`0 0 ${PAGE.w} ${PAGE.h}`}
      fontFamily="system-ui, sans-serif"
      role="img"
      aria-label={`Programme page ${page}`}
    >
      <rect width={PAGE.w} height={PAGE.h} fill="#fff" />
      <text x={M} y={40} fontSize={20} fontWeight={600}>
        {d.tender.title}
      </text>
      <text x={M} y={62} fontSize={13} fill="#444">
        {d.tender.number} · {d.name} · Data date {shortDate(d.startOn)} · Finish{' '}
        {shortDate(d.finishOn)} · {d.duration ?? 0} working days
      </text>
      <text x={PAGE.w - M} y={40} fontSize={12} textAnchor="end" fill="#444">
        Page {page} of {pages}
      </text>
      {/* Header */}
      {cols.map((c) => (
        <text key={c.label} x={c.x} y={top - 8} fontSize={11} fontWeight={600}>
          {c.label}
        </text>
      ))}
      {ticks.map((t) => (
        <g key={`t${t.day}`}>
          <line
            x1={x(t.day)}
            x2={x(t.day)}
            y1={top - 18}
            y2={top + rows.length * rowH}
            stroke="#f0f0f0"
          />
          <text x={x(t.day) + 2} y={top - 6} fontSize={9} fill="#555">
            {t.label}
          </text>
        </g>
      ))}
      {months.map((m) => (
        <g key={m.day}>
          <line
            x1={x(m.day)}
            x2={x(m.day)}
            y1={top - 34}
            y2={top + rows.length * rowH}
            stroke="#ccc"
          />
          <text x={x(m.day) + 3} y={top - 22} fontSize={10} fontWeight={600}>
            {m.label}
          </text>
        </g>
      ))}
      <line x1={M} x2={PAGE.w - M} y1={top} y2={top} stroke="#888" />
      {rows.map((a, i) => {
        const y = top + i * rowH;
        const summary = a.kind === 'summary';
        const s = a.earlyStart ? x(dayNo(a.earlyStart)) : 0;
        const f = a.earlyFinish ? x(dayNo(a.earlyFinish) + 1) : 0;
        return (
          <g
            key={a.id}
            fontSize={11}
            fontWeight={summary ? 600 : 400}
            fill={a.critical && !summary ? '#b91c1c' : '#000'}
          >
            <line x1={M} x2={PAGE.w - M} y1={y + rowH} y2={y + rowH} stroke="#eee" />
            <text x={cols[0]!.x} y={y + 16}>
              {a.code}
            </text>
            <text x={cols[1]!.x + a.depth * 12} y={y + 16}>
              {clip(a.name, 52 - a.depth * 2)}
            </text>
            <text x={cols[2]!.x + 30} y={y + 16} textAnchor="end">
              {a.duration}
            </text>
            <text x={cols[3]!.x} y={y + 16}>
              {shortDate(a.earlyStart)}
            </text>
            <text x={cols[4]!.x} y={y + 16}>
              {shortDate(a.earlyFinish)}
            </text>
            {a.earlyStart &&
              (summary ? (
                <rect x={s} y={y + 9} width={Math.max(2, f - s)} height={5} fill="#000" />
              ) : a.kind === 'milestone' ? (
                <path
                  d={`M ${f} ${y + 6} l 6 6 l -6 6 l -6 -6 z`}
                  fill={a.critical ? '#b91c1c' : '#000'}
                />
              ) : (
                <rect
                  x={s}
                  y={y + 6}
                  width={Math.max(2, f - s)}
                  height={12}
                  fill={a.critical ? '#dc2626' : '#2563eb'}
                />
              ))}
          </g>
        );
      })}
      <line x1={chartX} x2={chartX} y1={top - 24} y2={top + rows.length * rowH} stroke="#888" />
      {/* Legend */}
      <g fontSize={11} transform={`translate(${M}, ${PAGE.h - 30})`}>
        <rect width={18} height={10} y={-9} fill="#dc2626" />
        <text x={24}>Critical</text>
        <rect x={90} width={18} height={10} y={-9} fill="#2563eb" />
        <text x={114}>Non-critical</text>
        <path d="M 210 -10 l 6 6 l -6 6 l -6 -6 z" />
        <text x={222}>Milestone</text>
        <rect x={300} width={30} height={5} y={-7} />
        <text x={336}>Summary</text>
        <text x={PAGE.w - 2 * M} textAnchor="end" fill="#666">
          Rows {offset + 1}–{offset + rows.length} of {d.activities.length} · Printed{' '}
          {shortDate(today())}
        </text>
      </g>
    </svg>
  );
}
