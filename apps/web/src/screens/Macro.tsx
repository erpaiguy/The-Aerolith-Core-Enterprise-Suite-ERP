// A project's macro plan (docs/wave2a-plan.md step 5): its live schedules rolled up through the WBS, with a bar for
// each element against its baseline, progress by working days and the slip of its finish; the milestones; and the
// same roll-up by package, trade and zone. Read only: the schedules are where work is planned.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  Table,
  cx,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { dayNo, shortDate } from '../schedule/model';

interface Roll {
  activities: number;
  finished: number;
  inProgress: number;
  critical: number;
  start: string | null;
  finish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  progressPct: number | null;
  slipDays: number | null;
}

interface MacroPlan {
  schedules: {
    id: string;
    name: string;
    dataDate: string;
    finishOn: string | null;
    activityCount: number;
    baseline: { name: string; finishOn: string | null } | null;
  }[];
  project: Roll;
  wbs: (Roll & { id: string; code: string; name: string; depth: number })[];
  unassigned: Roll | null;
  milestones: {
    id: string;
    planId: string;
    schedule: string;
    code: string;
    name: string;
    date: string | null;
    baselineDate: string | null;
    actualDate: string | null;
    status: 'not_started' | 'in_progress' | 'finished';
    critical: boolean;
    wbsCode: string | null;
    slipDays: number | null;
  }[];
  byPackage: (Roll & { key: string | null })[];
  byTrade: (Roll & { key: string | null })[];
  byZone: (Roll & { key: string | null })[];
}

type View = 'wbs' | 'milestones' | 'package' | 'trade' | 'zone';
const VIEWS: { key: View; label: string }[] = [
  { key: 'wbs', label: 'By WBS' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'package', label: 'By package' },
  { key: 'trade', label: 'By trade' },
  { key: 'zone', label: 'By zone' },
];

const slip = (n: number | null) =>
  n === null ? '' : n === 0 ? 'on time' : n > 0 ? `+${n} d` : `${n} d`;

export function MacroScreen({ projectId }: { projectId: string }) {
  const [view, setView] = useState<View>('wbs');
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const macro = useQuery({
    queryKey: ['project-macro', projectId],
    queryFn: () => api.request<MacroPlan>(`/api/tenant/projects/${projectId}/macro`),
  });
  if (project.isPending || macro.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  if (macro.isError) return <Alert tone="danger">{describeError(macro.error)}</Alert>;
  const p = project.data;
  const m = macro.data;
  // One time scale for every bar: the earliest start to the latest finish, baselines included.
  const dates = [m.project, ...m.wbs]
    .flatMap((r) => [r.start, r.finish, r.baselineStart, r.baselineFinish])
    .filter((d): d is string => d !== null)
    .map(dayNo);
  const from = dates.length ? Math.min(...dates) : 0;
  const to = dates.length ? Math.max(...dates) + 1 : 1;
  const groups =
    view === 'package'
      ? m.byPackage
      : view === 'trade'
        ? m.byTrade
        : view === 'zone'
          ? m.byZone
          : [];
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> {p.number} · {p.name}
      </Link>
      <PageHeader
        title="Macro plan"
        subtitle={`${p.number} · ${p.name}: ${m.schedules.length} schedule${m.schedules.length === 1 ? '' : 's'} rolled up through the WBS`}
        actions={
          <Button variant="secondary" onClick={() => window.print()} className="print:hidden">
            <Printer className="size-4" aria-hidden /> Print
          </Button>
        }
      />
      {m.schedules.length === 0 ? (
        <Card>
          <EmptyState title="No live schedules yet.">
            Start one from the project&apos;s page.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <dl
              className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[repeat(4,auto)]"
              aria-label="Project totals"
            >
              <Total label="Start">{shortDate(m.project.start)}</Total>
              <Total label="Finish">
                {shortDate(m.project.finish)}{' '}
                {m.project.slipDays !== null && m.project.slipDays !== 0 && (
                  <Badge tone={m.project.slipDays > 0 ? 'danger' : 'success'}>
                    {slip(m.project.slipDays)} on baseline
                  </Badge>
                )}
              </Total>
              <Total label="Progress">
                <span data-testid="project-progress">{pct(m.project.progressPct)}</span>
              </Total>
              <Total label="Activities">
                {m.project.finished} done, {m.project.inProgress} going, {m.project.activities} in
                all
              </Total>
            </dl>
            <ul className="mt-3 space-y-0.5 text-xs text-fg-muted">
              {m.schedules.map((s) => (
                <li key={s.id}>
                  <Link
                    to="/programmes/$planId"
                    params={{ planId: s.id }}
                    className="text-accent hover:underline"
                  >
                    {s.name}
                  </Link>{' '}
                  · data date {shortDate(s.dataDate)} · finish {shortDate(s.finishOn)}
                  {s.baseline &&
                    ` · baseline ${s.baseline.name}, finish ${shortDate(s.baseline.finishOn)}`}
                </li>
              ))}
            </ul>
          </Card>
          <div className="flex flex-wrap gap-1 print:hidden" role="tablist" aria-label="Views">
            {VIEWS.map((v) => (
              <Button
                key={v.key}
                role="tab"
                aria-selected={view === v.key}
                variant={view === v.key ? 'primary' : 'ghost'}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </Button>
            ))}
          </div>
          {view === 'wbs' && (
            <Card>
              {m.wbs.length === 0 ? (
                <EmptyState title="The project has no WBS yet.">
                  Set up the WBS from the project&apos;s page to roll the schedules up by it.
                </EmptyState>
              ) : (
                <RollTable
                  label="Macro plan by WBS"
                  first="WBS element"
                  rows={[
                    ...m.wbs.map((r) => ({
                      key: r.id,
                      title: (
                        <span style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
                          <span className="mr-2 font-mono text-xs">{r.code}</span>
                          {r.name}
                        </span>
                      ),
                      bold: r.depth === 0,
                      roll: r,
                    })),
                    ...(m.unassigned
                      ? [
                          {
                            key: 'none',
                            title: <span className="italic text-fg-muted">No WBS element</span>,
                            bold: false,
                            roll: m.unassigned,
                          },
                        ]
                      : []),
                  ]}
                  from={from}
                  to={to}
                />
              )}
            </Card>
          )}
          {view === 'milestones' && (
            <Card>
              {m.milestones.length === 0 ? (
                <EmptyState title="No milestones in the schedules.">
                  Mark activities as milestones in a schedule to see them here.
                </EmptyState>
              ) : (
                <Table minWidth="44rem">
                  <thead>
                    <tr>
                      <th>Milestone</th>
                      <th>Schedule</th>
                      <th>WBS</th>
                      <th>Date</th>
                      <th>Baseline</th>
                      <th className="text-right">Slip</th>
                    </tr>
                  </thead>
                  <tbody aria-label="Milestones">
                    {m.milestones.map((x) => (
                      <tr key={`${x.planId}-${x.id}`} className={cx(x.critical && 'text-danger')}>
                        <td>
                          <span className="mr-2 font-mono text-xs">{x.code}</span>
                          {x.name}{' '}
                          {x.status === 'finished' && <Badge tone="success">reached</Badge>}
                        </td>
                        <td>{x.schedule}</td>
                        <td className="font-mono text-xs">{x.wbsCode ?? ''}</td>
                        <td className="whitespace-nowrap tabular-nums">
                          {shortDate(x.actualDate ?? x.date)}
                        </td>
                        <td className="whitespace-nowrap tabular-nums">
                          {shortDate(x.baselineDate)}
                        </td>
                        <td
                          className={cx(
                            'whitespace-nowrap text-right tabular-nums',
                            (x.slipDays ?? 0) > 0 && 'text-danger',
                          )}
                        >
                          {slip(x.slipDays)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
          {(view === 'package' || view === 'trade' || view === 'zone') && (
            <Card>
              <RollTable
                label={`Macro plan by ${view}`}
                first={view === 'package' ? 'Package' : view === 'trade' ? 'Trade' : 'Zone'}
                rows={groups.map((g) => ({
                  key: g.key ?? '—',
                  title: g.key ?? <span className="italic text-fg-muted">Not set</span>,
                  bold: false,
                  roll: g,
                }))}
                from={from}
                to={to}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const pct = (n: number | null) => (n === null ? '-' : `${n.toLocaleString('en-IN')}%`);

function Total({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/** Rows of a roll-up, each with its dates, a bar to one scale (the baseline under it), progress and slip. */
function RollTable({
  label,
  first,
  rows,
  from,
  to,
}: {
  label: string;
  first: string;
  rows: { key: string; title: ReactNode; bold: boolean; roll: Roll }[];
  from: number;
  to: number;
}) {
  const at = (d: string) => `${((dayNo(d) - from) / (to - from)) * 100}%`;
  const width = (s: string, f: string) => `${((dayNo(f) + 1 - dayNo(s)) / (to - from)) * 100}%`;
  return (
    <Table minWidth="60rem">
      <thead>
        <tr>
          <th>{first}</th>
          <th>Start</th>
          <th>Finish</th>
          <th className="w-[28%]">
            {shortDate(new Date(from * 86_400_000).toISOString().slice(0, 10))} –{' '}
            {shortDate(new Date((to - 1) * 86_400_000).toISOString().slice(0, 10))}
          </th>
          <th className="text-right">Progress</th>
          <th className="text-right">Slip</th>
          <th className="text-right">Activities</th>
        </tr>
      </thead>
      <tbody aria-label={label}>
        {rows.map(({ key, title, bold, roll: r }) => (
          <tr key={key} className={cx(bold && 'font-semibold')}>
            <td>{title}</td>
            <td className="whitespace-nowrap tabular-nums">{shortDate(r.start)}</td>
            <td className="whitespace-nowrap tabular-nums">{shortDate(r.finish)}</td>
            <td>
              <div className="relative h-4" aria-hidden>
                {r.start && r.finish && (
                  <div
                    className={cx(
                      'absolute top-0 h-2.5 rounded-sm',
                      r.critical > 0 ? 'bg-danger' : 'bg-info',
                    )}
                    style={{ left: at(r.start), width: width(r.start, r.finish) }}
                  >
                    {r.progressPct !== null && r.progressPct > 0 && (
                      <div
                        className="h-full rounded-sm bg-fg/40"
                        style={{ width: `${Math.min(100, r.progressPct)}%` }}
                      />
                    )}
                  </div>
                )}
                {r.baselineStart && r.baselineFinish && (
                  <div
                    className="absolute top-3 h-1 rounded-sm bg-fg-muted"
                    style={{
                      left: at(r.baselineStart),
                      width: width(r.baselineStart, r.baselineFinish),
                    }}
                  />
                )}
              </div>
            </td>
            <td className="text-right tabular-nums">{pct(r.progressPct)}</td>
            <td
              className={cx(
                'whitespace-nowrap text-right tabular-nums',
                (r.slipDays ?? 0) > 0 && 'text-danger',
              )}
            >
              {slip(r.slipDays)}
            </td>
            <td className="whitespace-nowrap text-right tabular-nums">
              {r.finished}/{r.activities}
              {r.critical > 0 && (
                <span className="ml-1 text-xs text-danger">({r.critical} crit.)</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
