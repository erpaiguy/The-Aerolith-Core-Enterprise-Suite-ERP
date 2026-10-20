// Plans: the Programme tab of a tender (docs/wave1-plan.md step 11), and the editor shared by a tender's programme and
// a project's schedule (docs/wave2a-plan.md step 4): activities grid beside the bar chart, recalculated on every change
// by the server, and its print view. A project schedule adds progress as of a data date, WBS elements, baselines,
// resources, the resources needed week by week, and the look-ahead.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Textarea,
  cx,
  toast,
  useConfirm,
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
  Download,
  IndentDecrease,
  IndentIncrease,
  Plus,
  Printer,
  ListChecks,
  Settings,
  Trash2,
  Upload,
  Users,
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
import { api, ApiError, saveFile } from '../api/client';
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = await api.upload<{ plan: ProgrammeDetail; report: ImportReport['report'] }>(
        `/api/tenant/tenders/${tenderId}/programmes/import`,
        file,
      );
      setReport({ planId: r.plan.id, name: r.plan.name, report: r.report });
      toast.success(`Programme ${r.plan.name} imported`);
      void list.refetch();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.request<ProgrammeDetail>(`/api/tenant/tenders/${tenderId}/programmes`, {
        method: 'POST',
        body: { name, startOn },
      });
      toast.success(`Programme ${p.name} created`);
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
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" busy={busy} onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" aria-hidden /> Import file
            </Button>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> New programme
            </Button>
          </div>
        )
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".xml,.xer"
        className="sr-only"
        tabIndex={-1}
        aria-label="Programme file to import"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      {report && <ImportResult result={report} />}
      <p className="mb-3 text-sm text-fg-muted">
        The programme submitted with the bid: activities, links, calendars and the critical path. It
        is a document of the tender; winning does not turn it into a project schedule. Import one
        from MS Project (saved as XML) or Primavera P6 (XER) as a new programme.
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
        <EmptyState title="No programme yet.">
          {canEdit
            ? 'Start one with "New programme", or import an MS Project or Primavera P6 file.'
            : 'A planner starts the programme for the bid.'}
        </EmptyState>
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

interface ImportReport {
  planId: string;
  name: string;
  report: {
    format: 'mspdi' | 'xer';
    activities: number;
    links: number;
    calendars: number;
    fileFinish: string | null;
    finish: string | null;
    warnings: string[];
  };
}

/** What an import brought in, what it could not, and whether the finish agrees with the file's own. */
function ImportResult({ result: { planId, name, report: r } }: { result: ImportReport }) {
  const differs = r.fileFinish && r.finish && r.fileFinish !== r.finish;
  return (
    <div className="mb-4">
      <Alert tone={r.warnings.length || differs ? 'warning' : 'success'}>
        <p>
          Imported{' '}
          <Link to="/programmes/$planId" params={{ planId }} className="font-medium underline">
            {name}
          </Link>{' '}
          from {r.format === 'xer' ? 'Primavera P6' : 'MS Project'}: {r.activities} activities,{' '}
          {r.links} links, {r.calendars} calendar{r.calendars === 1 ? '' : 's'}.
        </p>
        {differs ? (
          <p className="mt-1">
            Recalculated here it finishes {shortDate(r.finish)}; the file said{' '}
            {shortDate(r.fileFinish)}. The difference usually comes from hours-based durations,
            progress, or settings in the file that this programme does not use (see below).
          </p>
        ) : (
          r.finish && <p className="mt-1">It finishes {shortDate(r.finish)}, as the file said.</p>
        )}
        {r.warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </Alert>
    </div>
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
    void qc.invalidateQueries({ queryKey: ['programmes', p.tenderId ?? p.projectId] });
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
const COLS_BASELINE =
  'grid-cols-[2.25rem_5rem_minmax(11rem,1fr)_3.25rem_5.25rem_5.25rem_7rem_3rem_3rem]';
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
/** " (+3 days)" when the finish moved from the baseline's, in calendar days. */
const variance = (base: string | null, now: string | null) => {
  if (!base || !now) return '';
  const n = dayNo(now) - dayNo(base);
  return n === 0 ? ', on time' : ` (${signed(n)} day${Math.abs(n) === 1 ? '' : 's'})`;
};

export function ProgrammeScreen({ planId }: { planId: string }) {
  const canEditRole = usePermission('programme.edit');
  const confirm = useConfirm();
  const { plan, busy, error, setError, edit, post, lastIdMap } = usePlan(planId);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<Zoom>('week');
  const [scrollTop, setScrollTop] = useState(0);
  const [panel, setPanel] = useState<'calendars' | 'settings' | 'resources' | null>(null);
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
  const schedule = d.kind === 'project_schedule';
  const baseline = d.baselines?.find((b) => b.id === d.baselineId) ?? null;
  const cols = baseline ? COLS_BASELINE : COLS;
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
  const remove = async () => {
    if (!sel) return;
    const under = d.activities.filter((a) => a.parentId === sel.id).length;
    if (
      under &&
      !(await confirm({
        title: `Delete ${sel.code} and everything under it?`,
        body: `${sel.name} and the ${under} activit${under === 1 ? 'y' : 'ies'} indented under it are deleted, with their links.`,
        confirmLabel: 'Delete the activities',
        tone: 'danger',
      }))
    )
      return;
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
    else if (e.key === 'Delete' && sel) void remove();
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
      {d.owner.kind === 'tender' ? (
        <Link
          to="/tenders/$tenderId"
          params={{ tenderId: d.owner.id }}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {d.owner.number} · {d.owner.title}
        </Link>
      ) : (
        <Link
          to="/projects/$projectId"
          params={{ projectId: d.owner.id }}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {d.owner.number} · {d.owner.title}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{d.name}</h1>
          <p className="mt-1 text-sm text-fg-muted" data-testid="programme-summary">
            {shortDate(d.startOn)} to {shortDate(d.finishOn)} · {d.duration ?? 0} working days ·{' '}
            {d.activityCount} activities{d.archivedAt && ' · archived'}
            {schedule && ` · data date ${shortDate(d.dataDate ?? d.startOn)}`}
            {baseline && (
              <>
                {' · '}
                <span data-testid="baseline-variance">
                  against {baseline.name}: finish {shortDate(baseline.finishOn)}
                  {variance(baseline.finishOn, d.finishOn)}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setPanel(panel === 'calendars' ? null : 'calendars')}
          >
            <CalendarDays className="size-4" aria-hidden /> Calendars
          </Button>
          {schedule && (
            <>
              <Button
                variant="secondary"
                onClick={() => setPanel(panel === 'resources' ? null : 'resources')}
              >
                <Users className="size-4" aria-hidden /> Resources
              </Button>
              <Link
                to="/programmes/$planId/lookahead"
                params={{ planId }}
                className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3"
              >
                <ListChecks className="size-4" aria-hidden /> Look-ahead
              </Link>
              <Link
                to="/programmes/$planId/make-ready"
                params={{ planId }}
                className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3"
              >
                Weekly plan
              </Link>
            </>
          )}
          {canEditRole && (
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            >
              <Settings className="size-4" aria-hidden /> Settings
            </Button>
          )}
          <ExportMenu planId={planId} onError={setError} />
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
          key={`${d.baselineId ?? ''}-${d.baselines?.length ?? 0}`}
          plan={d}
          busy={busy}
          onSave={(body) =>
            void post('', (x) => ({ rowVersion: x.rowVersion, ...body })).then((ok) => {
              if (!ok) return;
              toast.success(`${schedule ? 'Schedule' : 'Programme'} settings saved`);
              setPanel(null);
            })
          }
          onArchive={async (archived) => {
            const what = schedule ? 'schedule' : 'programme';
            if (
              archived &&
              !(await confirm({
                title: `Archive ${d.name}?`,
                body: `The ${what} becomes read-only: nobody can change its activities until it is restored.`,
                confirmLabel: `Archive the ${what}`,
                tone: 'danger',
              }))
            )
              return;
            if (await post('/archive', () => ({ archived })))
              toast.success(`${d.name} ${archived ? 'archived' : 'restored'}`);
          }}
          onBaseline={(name) =>
            post('/baselines', () => ({ name })).then((ok) => {
              if (ok) toast.success(`Baseline ${name} taken`);
              return ok;
            })
          }
        />
      )}
      {panel === 'resources' && <ResourceLoad planId={planId} />}
      {panel === 'calendars' && (
        <CalendarsPanel
          plan={d}
          canEdit={canEditRole && !d.archivedAt}
          busy={busy}
          onSave={(id, body) =>
            post(id ? `/calendars/${id}` : '/calendars', (x) => ({
              rowVersion: x.rowVersion,
              ...body,
            })).then((ok) => {
              if (ok) toast.success(`Calendar ${body.name} saved`);
              return ok;
            })
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
              onClick={() => void remove()}
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
          <div
            style={{
              height: HEAD_H + rows.length * ROW_H + 40,
              minWidth: baseline ? '45rem' : '42rem',
            }}
          >
            <div
              role="row"
              className={cx(
                'sticky top-0 z-10 grid items-end border-b border-line bg-surface pb-1.5 text-xs font-medium text-fg-muted',
                cols,
              )}
              style={{ height: HEAD_H }}
            >
              {[
                '#',
                'ID',
                'Activity',
                'Days',
                'Start',
                'Finish',
                'Predecessors',
                'Float',
                ...(baseline ? ['Var'] : []),
              ].map((h) => (
                <div
                  key={h}
                  role="columnheader"
                  className="px-2"
                  title={
                    h === 'Var' ? `Finish against ${baseline?.name}, in days (+ late)` : undefined
                  }
                >
                  {h}
                </div>
              ))}
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
                    cols,
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
                    {a.status && a.status !== 'not_started' && !summary && (
                      <span
                        className={cx(
                          'mr-1 shrink-0 text-xs',
                          a.status === 'finished' ? 'text-success' : 'text-accent',
                        )}
                        title={a.status === 'finished' ? 'Finished' : 'In progress'}
                        data-testid={`status-${a.code}`}
                      >
                        {a.status === 'finished' ? '✓' : '◐'}
                      </span>
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
                  {baseline && (
                    <div
                      role="gridcell"
                      className={cx(
                        'px-2 text-right text-xs tabular-nums',
                        a.baselineFinish && a.earlyFinish && a.earlyFinish > a.baselineFinish
                          ? 'text-danger'
                          : '',
                      )}
                    >
                      {a.baselineFinish && a.earlyFinish
                        ? signed(dayNo(a.earlyFinish) - dayNo(a.baselineFinish))
                        : ''}
                    </div>
                  )}
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
          dataDate={d.dataDate ?? d.startOn}
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

function ExportMenu({ planId, onError }: { planId: string; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (format: 'mspdi' | 'xer' | 'xlsx') => {
    setBusy(format);
    onError(null);
    try {
      const { blob, fileName } = await api.download(
        `/api/tenant/programmes/${planId}/export?format=${format}`,
      );
      saveFile(blob, fileName);
    } catch (err) {
      onError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      className="flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1"
      role="group"
      aria-label="Export"
    >
      <Download className="ml-2 size-4 text-fg-muted" aria-hidden />
      {(
        [
          ['mspdi', 'MS Project'],
          ['xer', 'Primavera'],
          ['xlsx', 'Excel'],
        ] as const
      ).map(([f, label]) => (
        <Button key={f} variant="ghost" busy={busy === f} onClick={() => void download(f)}>
          {label}
        </Button>
      ))}
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
      {plan.kind === 'project_schedule' && (
        <div className="mt-4 grid gap-4 border-t border-line pt-4 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-4">
            {!summary && (
              <ProgressForm plan={plan} activity={a} canEdit={canEdit} onSave={onSave} />
            )}
            <WbsPicker plan={plan} activity={a} canEdit={canEdit} onSave={onSave} />
            <GroupFields plan={plan} activity={a} canEdit={canEdit} onSave={onSave} />
          </div>
          {a.kind === 'task' && (
            <div className="space-y-4">
              <ActivityLines plan={plan} activityId={a.id} canEdit={canEdit} />
              <ActivityResources planId={plan.id} activityId={a.id} canEdit={canEdit} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Progress as of the data date: when it started and finished, or the working days still to do. */
function ProgressForm({
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
  const milestone = a.kind === 'milestone';
  const [start, setStart] = useState(a.actualStart ?? '');
  const [finish, setFinish] = useState(a.actualFinish ?? '');
  const [left, setLeft] = useState(
    a.remaining === null || a.remaining === undefined ? '' : String(a.remaining),
  );
  const asOf = plan.dataDate ?? plan.startOn;
  return (
    <form
      className="space-y-2"
      aria-label="Progress"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          op: 'update',
          id: a.id,
          progress: start
            ? {
                actualStart: start,
                actualFinish: milestone ? null : finish || null,
                remaining: finish || milestone || left === '' ? null : Number(left),
              }
            : null,
        });
      }}
    >
      <h3 className="text-sm font-medium">
        Progress as of {shortDate(asOf)}{' '}
        {a.status === 'finished' ? (
          <Badge tone="success">finished</Badge>
        ) : a.status === 'in_progress' ? (
          <Badge tone="accent">in progress, {a.remainingLeft ?? 0} days left</Badge>
        ) : (
          <Badge tone="neutral">not started</Badge>
        )}
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={milestone ? 'Reached on' : 'Actual start'}>
          <Input
            type="date"
            value={start}
            max={asOf}
            onChange={(e) => setStart(e.target.value)}
            disabled={!canEdit}
          />
        </Field>
        {!milestone && (
          <>
            <Field label="Actual finish">
              <Input
                type="date"
                value={finish}
                min={start || undefined}
                max={asOf}
                onChange={(e) => setFinish(e.target.value)}
                disabled={!canEdit || !start}
              />
            </Field>
            <Field label="Days left" hint="Blank: worked out from the duration.">
              <Input
                inputMode="numeric"
                value={left}
                onChange={(e) => setLeft(e.target.value.replace(/[^0-9]/g, ''))}
                disabled={!canEdit || !start || Boolean(finish)}
              />
            </Field>
          </>
        )}
      </div>
      {canEdit && (
        <Button type="submit" variant="secondary">
          Save progress
        </Button>
      )}
    </form>
  );
}

function WbsPicker({
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
  const wbs = useQuery({
    queryKey: ['project-wbs', plan.projectId],
    queryFn: () =>
      api.request<{ id: string; code: string; name: string; depth: number }[]>(
        `/api/tenant/projects/${plan.projectId}/wbs`,
      ),
  });
  return (
    <Field label="WBS element">
      <Select
        value={a.wbsId ?? ''}
        disabled={!canEdit || !wbs.data}
        onChange={(e) => onSave({ op: 'update', id: a.id, wbsId: e.target.value || null })}
      >
        <option value="">None</option>
        {wbs.data?.map((w) => (
          <option key={w.id} value={w.id}>
            {'\u00a0\u00a0'.repeat(w.depth)}
            {w.code} · {w.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Package, trade and zone: how the macro plan groups the activity besides its WBS element. */
function GroupFields({
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
  const [v, setV] = useState({
    package: a.package ?? '',
    trade: a.trade ?? '',
    zone: a.zone ?? '',
  });
  const used = useQuery({
    queryKey: ['activity-groups', plan.projectId],
    queryFn: () =>
      api.request<Record<'package' | 'trade' | 'zone', string[]>>(
        `/api/tenant/projects/${plan.projectId}/activity-groups`,
      ),
  });
  const changed =
    v.package !== (a.package ?? '') || v.trade !== (a.trade ?? '') || v.zone !== (a.zone ?? '');
  return (
    <form
      aria-label="Groups"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ op: 'update', id: a.id, ...v });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {(['package', 'trade', 'zone'] as const).map((k) => (
          <div key={k}>
            <Field label={k === 'package' ? 'Package' : k === 'trade' ? 'Trade' : 'Zone'}>
              <Input
                value={v[k]}
                list={`groups-${k}`}
                maxLength={60}
                disabled={!canEdit}
                onChange={(e) => setV({ ...v, [k]: e.target.value })}
                placeholder={k === 'zone' ? 'Block, floor, area' : undefined}
              />
            </Field>
            <datalist id={`groups-${k}`}>
              {used.data?.[k].map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </div>
        ))}
      </div>
      {canEdit && changed && (
        <Button type="submit" variant="secondary">
          Save groups
        </Button>
      )}
    </form>
  );
}

interface ActivityLinesView {
  lines: {
    lineKey: string;
    boqId: string;
    code: string | null;
    description: string;
    unit: string | null;
    qty: string | null;
    amount: string | null;
    done: string;
  }[];
  value: string;
  physicalPct: number | null;
}

/** The contract BOQ items the activity carries out: its physical progress is theirs (by contract value). */
function ActivityLines({
  plan,
  activityId,
  canEdit,
}: {
  plan: ProgrammeDetail;
  activityId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const key = ['activity-lines', plan.id, activityId];
  const url = `/api/tenant/programmes/${plan.id}/activities/${activityId}/lines`;
  const data = useQuery({ queryKey: key, queryFn: () => api.request<ActivityLinesView>(url) });
  const contracts = useQuery({
    queryKey: ['project-boqs', plan.projectId],
    queryFn: () =>
      api.request<{ id: string; name: string; kind: string; archivedAt: string | null }[]>(
        `/api/tenant/projects/${plan.projectId}/boqs`,
      ),
    select: (bs) => bs.filter((b) => b.kind === 'contract' && !b.archivedAt),
  });
  const [boqId, setBoqId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = boqId || contracts.data?.[0]?.id || '';
  const save = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<ActivityLinesView>(`${url}${path}`, { method: 'POST', body }),
      );
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const d = data.data;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        BOQ items{' '}
        {d && d.physicalPct !== null && (
          <Badge tone="success">
            <span data-testid="activity-physical">{d.physicalPct}% done</span>
          </Badge>
        )}
      </h3>
      {d?.lines.length ? (
        <ul className="space-y-1 text-sm" aria-label="Activity BOQ items">
          {d.lines.map((l) => (
            <li key={l.lineKey} className="flex items-center gap-2">
              <span className="font-mono text-xs">{l.code}</span>
              <span className="min-w-0 flex-1 truncate">{l.description}</span>
              <span className="whitespace-nowrap text-xs tabular-nums text-fg-muted">
                {Number(l.done).toLocaleString('en-IN')} /{' '}
                {Number(l.qty ?? 0).toLocaleString('en-IN')} {l.unit}
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  aria-label={`Unlink ${l.code}`}
                  onClick={() =>
                    void save('/remove', { lineKey: l.lineKey }).then(
                      (ok) => ok && toast.success(`${l.code} unlinked`),
                    )
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">
          None. Link the items it carries out to measure its physical progress.
        </p>
      )}
      {canEdit && (contracts.data?.length ?? 0) > 0 && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save('', { boqId: chosen, code: code.trim() }).then((ok) => {
              if (!ok) return;
              toast.success(`${code.trim()} linked`);
              setCode('');
            });
          }}
        >
          {(contracts.data?.length ?? 0) > 1 && (
            <Field label="Contract BOQ">
              <Select value={chosen} onChange={(e) => setBoqId(e.target.value)}>
                {contracts.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Item or section code" hint="A section brings every item under it.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} className="w-36" />
          </Field>
          <Button type="submit" variant="secondary" disabled={!code.trim() || !chosen}>
            Link
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

interface Assignment {
  resourceId: string;
  code: string;
  name: string;
  unit: string;
  kind: string;
  unitsPerDay: string;
}

/** The rate library's resources the activity needs each working day. */
function ActivityResources({
  planId,
  activityId,
  canEdit,
}: {
  planId: string;
  activityId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const key = ['activity-resources', planId, activityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Assignment[]>(
        `/api/tenant/programmes/${planId}/activities/${activityId}/resources`,
      ),
  });
  const [q, setQ] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [units, setUnits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const found = useQuery({
    queryKey: ['resource-search', q],
    queryFn: () =>
      api.request<{ items: { id: string; code: string; name: string; unit: string }[] }>(
        `/api/tenant/resources?limit=20&q=${encodeURIComponent(q)}`,
      ),
    enabled: canEdit,
  });
  const save = async (rid: string, unitsPerDay: string | null) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Assignment[]>(`/api/tenant/programmes/${planId}/assignments`, {
          method: 'POST',
          body: { activityId, resourceId: rid, unitsPerDay },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['programme-resources', planId] });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Resources a working day</h3>
      {list.data?.length ? (
        <ul className="space-y-1 text-sm" aria-label="Activity resources">
          {list.data.map((r) => (
            <li key={r.resourceId} className="flex items-center gap-2">
              <span className="font-mono text-xs">{r.code}</span>
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="tabular-nums">
                {Number(r.unitsPerDay).toLocaleString('en-IN')} {r.unit}
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  aria-label={`Take ${r.code} off`}
                  onClick={() =>
                    void save(r.resourceId, null).then(
                      (ok) => ok && toast.success(`${r.code} taken off`),
                    )
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">None.</p>
      )}
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(resourceId, units.trim()).then((ok) => {
              if (!ok) return;
              toast.success('Resource put on the activity');
              setUnits('');
            });
          }}
        >
          <Field label="Find a resource">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name" />
          </Field>
          <Field label="Resource">
            <Select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">Choose…</option>
              {found.data?.items.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name} ({r.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Units a day">
            <Input
              inputMode="decimal"
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              className="w-24"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={!resourceId || !units.trim()}>
            Add
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function SettingsPanel({
  plan,
  busy,
  onSave,
  onArchive,
  onBaseline,
}: {
  plan: ProgrammeDetail;
  busy: boolean;
  onSave: (body: {
    name: string;
    startOn: string;
    calendarId: string;
    notes: string;
    dataDate?: string | null;
    baselineId?: string | null;
  }) => void;
  onArchive: (archived: boolean) => void | Promise<void>;
  onBaseline: (name: string) => Promise<boolean>;
}) {
  const schedule = plan.kind === 'project_schedule';
  const [v, setV] = useState({
    name: plan.name,
    startOn: plan.startOn,
    calendarId: plan.calendarId,
    notes: plan.notes,
    dataDate: plan.dataDate ?? '',
    baselineId: plan.baselineId ?? '',
  });
  const [baselineName, setBaselineName] = useState('');
  return (
    <Card title={schedule ? 'Schedule settings' : 'Programme settings'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const { dataDate, baselineId, ...base } = v;
          // Only what was changed here: a baseline taken meanwhile stays shown.
          onSave({
            ...base,
            ...(schedule && (dataDate || null) !== plan.dataDate
              ? { dataDate: dataDate || null }
              : {}),
            ...(schedule && (baselineId || null) !== plan.baselineId
              ? { baselineId: baselineId || null }
              : {}),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={schedule ? 'Schedule name' : 'Programme name'}>
            <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
          </Field>
          <Field
            label={schedule ? 'Start' : 'Data date'}
            hint={schedule ? 'Nothing is planned before it.' : 'Nothing starts before it.'}
          >
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
          {schedule && (
            <>
              <Field
                label="Data date"
                hint="Progress is as of this day; what is not done is planned from it."
              >
                <Input
                  type="date"
                  value={v.dataDate}
                  onChange={(e) => setV({ ...v, dataDate: e.target.value })}
                />
              </Field>
              <Field label="Baseline shown">
                <Select
                  value={v.baselineId}
                  onChange={(e) => setV({ ...v, baselineId: e.target.value })}
                >
                  <option value="">None</option>
                  {plan.baselines.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({shortDate(b.dataDate)})
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
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
          <Button type="button" variant="ghost" onClick={() => void onArchive(!plan.archivedAt)}>
            {plan.archivedAt
              ? `Restore ${schedule ? 'schedule' : 'programme'}`
              : `Archive ${schedule ? 'schedule' : 'programme'}`}
          </Button>
        </div>
      </form>
      {schedule && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onBaseline(baselineName.trim()).then((ok) => ok && setBaselineName(''));
          }}
        >
          <Field
            label="Take a baseline"
            hint={`The dates as they are now, kept for good to measure slippage against. ${plan.baselines.length} taken.`}
          >
            <Input
              value={baselineName}
              onChange={(e) => setBaselineName(e.target.value)}
              placeholder="e.g. Approved schedule"
              maxLength={100}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={!baselineName.trim() || busy}>
            Take baseline
          </Button>
        </form>
      )}
    </Card>
  );
}

/** The resources the schedule needs week by week from the data date. */
function ResourceLoad({ planId }: { planId: string }) {
  const [weeks, setWeeks] = useState(12);
  const load = useQuery({
    queryKey: ['programme-resources', planId, weeks],
    queryFn: () =>
      api.request<ResourceLoadView>(`/api/tenant/programmes/${planId}/resources?weeks=${weeks}`),
  });
  return (
    <Card
      title="Resources needed"
      actions={
        <div className="w-32 shrink-0">
          <Select
            aria-label="Weeks"
            className="w-32"
            value={weeks}
            onChange={(e) => setWeeks(Number(e.target.value))}
          >
            {[4, 8, 12, 26, 52].map((n) => (
              <option key={n} value={n}>
                {n} weeks
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {load.isPending ? (
        <Spinner />
      ) : load.isError ? (
        <Alert tone="danger">{describeError(load.error)}</Alert>
      ) : load.data.resources.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No resources on activities still to do. Put them on activities in the activity panel.
        </p>
      ) : (
        <Table minWidth={`${16 + load.data.weeks.length * 4}rem`}>
          <thead>
            <tr>
              <th>Resource</th>
              {load.data.weeks.map((w) => (
                <th key={w} className="text-right" title={`Week of ${w}`}>
                  {shortDate(w)}
                </th>
              ))}
              <th className="text-right">Later</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody aria-label="Resources by week">
            {load.data.resources.map((r) => {
              const peak = Math.max(...r.byWeek, 0);
              return (
                <tr key={r.id}>
                  <td>
                    <span className="mr-2 font-mono text-xs">{r.code}</span>
                    {r.name} <span className="text-xs text-fg-muted">({r.unit})</span>
                  </td>
                  {r.byWeek.map((n, i) => (
                    <td
                      key={i}
                      className="text-right tabular-nums"
                      style={{
                        background:
                          n > 0 && peak > 0
                            ? `color-mix(in srgb, var(--accent) ${Math.round((n / peak) * 35)}%, transparent)`
                            : undefined,
                      }}
                    >
                      {n ? formatUnits(n) : ''}
                    </td>
                  ))}
                  <td className="text-right tabular-nums">{r.later ? formatUnits(r.later) : ''}</td>
                  <td className="text-right font-medium tabular-nums">{formatUnits(r.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface ResourceLoadView {
  from: string;
  weeks: string[];
  resources: {
    id: string;
    code: string;
    name: string;
    unit: string;
    kind: string;
    byWeek: number[];
    later: number;
    total: number;
  }[];
}

const formatUnits = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

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
        {d.owner.title}
      </text>
      <text x={M} y={62} fontSize={13} fill="#444">
        {d.owner.number} · {d.name} · Data date {shortDate(d.dataDate ?? d.startOn)} · Finish{' '}
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

interface Lookahead {
  from: string;
  to: string;
  weeks: number;
  activities: {
    id: string;
    code: string;
    name: string;
    kind: string;
    status: 'not_started' | 'in_progress';
    start: string;
    finish: string;
    actualStart: string | null;
    remaining: number | null;
    totalFloat: number | null;
    critical: boolean;
    wbsCode: string | null;
    summary: string | null;
  }[];
}

/**
 * The look-ahead: activities on or due to start in the next weeks from the data date, by start, for the site's weekly
 * meeting; printed on A4 landscape from the browser.
 */
export function LookaheadPrint({ planId }: { planId: string }) {
  const [weeks, setWeeks] = useState(3);
  const plan = useQuery({
    queryKey: ['programme', planId],
    queryFn: () => api.request<ProgrammeDetail>(`/api/tenant/programmes/${planId}`),
  });
  const la = useQuery({
    queryKey: ['programme-lookahead', planId, weeks],
    queryFn: () =>
      api.request<Lookahead>(`/api/tenant/programmes/${planId}/lookahead?weeks=${weeks}`),
  });
  if (plan.isPending || la.isPending) return <Spinner />;
  if (plan.isError) return <Alert tone="danger">{describeError(plan.error)}</Alert>;
  if (la.isError) return <Alert tone="danger">{describeError(la.error)}</Alert>;
  const d = plan.data;
  const l = la.data;
  return (
    <div className="min-h-screen bg-white p-6 text-black">
      <style>
        {'@page { size: A4 landscape; margin: 12mm } @media print { .no-print { display: none } }'}
      </style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Link
          to="/programmes/$planId"
          params={{ planId }}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to the schedule
        </Link>
        <div className="w-44">
          <Select
            aria-label="Weeks ahead"
            className="w-36"
            value={weeks}
            onChange={(e) => setWeeks(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n} week{n === 1 ? '' : 's'} ahead
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print or save as PDF
        </Button>
      </div>
      <h1 className="text-lg font-semibold">
        Look-ahead · {d.owner.number} · {d.owner.title}
      </h1>
      <p className="mb-3 text-sm text-gray-700" data-testid="lookahead-range">
        {d.name}: {shortDate(l.from)} to {shortDate(l.to)} ({l.weeks} week{l.weeks === 1 ? '' : 's'}
        ), as of the data date {shortDate(l.from)} · {l.activities.length} activities
      </p>
      <table className="w-full border-collapse text-sm" aria-label="Look-ahead">
        <thead>
          <tr className="border-b-2 border-black text-left">
            {[
              'ID',
              'Activity',
              'Under',
              'WBS',
              'Start',
              'Finish',
              'Days left',
              'Float',
              'Status',
            ].map((h) => (
              <th key={h} className="px-1.5 py-1 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {l.activities.map((a) => (
            <tr key={a.id} className={cx('border-b border-gray-200', a.critical && 'text-red-700')}>
              <td className="px-1.5 py-1 font-mono text-xs">{a.code}</td>
              <td className="px-1.5 py-1">{a.name}</td>
              <td className="px-1.5 py-1 text-gray-600">{a.summary ?? ''}</td>
              <td className="px-1.5 py-1 font-mono text-xs">{a.wbsCode ?? ''}</td>
              <td className="px-1.5 py-1 tabular-nums">{shortDate(a.start)}</td>
              <td className="px-1.5 py-1 tabular-nums">{shortDate(a.finish)}</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{a.remaining ?? ''}</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{a.totalFloat ?? ''}</td>
              <td className="px-1.5 py-1">
                {a.status === 'in_progress' ? 'In progress' : a.critical ? 'Critical' : 'To start'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {l.activities.length === 0 && (
        <p className="mt-3 text-sm text-gray-600">Nothing on or due in these weeks.</p>
      )}
    </div>
  );
}
