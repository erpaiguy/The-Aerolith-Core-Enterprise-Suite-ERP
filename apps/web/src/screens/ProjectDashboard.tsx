// A project's dashboard (docs/wave2a-plan.md step 7): where the project stands on one page, printable. The money
// (contract, budget, the work done), each schedule's finish against its baseline with its progress three ways
// (planned, scheduled, measured) side by side, the S-curve (planned, forecast, earned), the next two weeks and the
// next milestones. Read only: each figure links to where it is kept.
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
import { useMemo, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { ChartFigure } from '../charts/ChartFigure';
import type { ChartOption } from '../charts/EChart';
import { valueAxis } from '../charts/measure';
import { describeError, formatInr, formatInrShort } from '../lib/format';
import { shortDate } from '../schedule/model';
import type { Done } from './Progress';
import { printLink } from '../print/Letterhead';

export interface ProjectDashboard {
  asOf: string;
  money: {
    contractValue: string | null;
    contract: string;
    budget: string;
    margin: string | null;
    marginPct: string | null;
    boqs: {
      contractId: string;
      name: string;
      contract: string;
      budget: string | null;
      margin: string | null;
    }[];
  };
  progress: {
    from: string;
    to: string;
    total: Done;
    sections: (Done & { boq: string; code: string | null; description: string })[];
  };
  schedules: {
    id: string;
    name: string;
    dataDate: string;
    finish: string | null;
    baselineName: string | null;
    baselineFinish: string | null;
    slipDays: number | null;
    activities: number;
    finished: number;
    inProgress: number;
    critical: number;
    lateToBaseline: number;
    plannedPct: number | null;
    scheduledPct: number | null;
    measuredPct: number | null;
    linkedValue: string;
  }[];
  curve: {
    months: string[];
    planned: number[] | null;
    forecast: number[];
    earned: (number | null)[];
    linkedValue: string;
  } | null;
  lookahead: {
    days: number;
    activities: {
      planId: string;
      schedule: string;
      id: string;
      code: string;
      name: string;
      status: 'not_started' | 'in_progress' | 'finished';
      start: string;
      finish: string;
      critical: boolean;
      totalFloat: number | null;
      wbsCode: string | null;
    }[];
    more: boolean;
  };
  milestones: {
    planId: string;
    schedule: string;
    id: string;
    code: string;
    name: string;
    date: string | null;
    baselineDate: string | null;
    slipDays: number | null;
    critical: boolean;
  }[];
}

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '-' : `${n.toLocaleString('en-IN')}%`;
const slip = (n: number | null) =>
  n === null ? '' : n === 0 ? 'on time' : n > 0 ? `+${n} d` : `${n} d`;
const MONTH = new Intl.DateTimeFormat('en-IN', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});
const monthLabel = (m: string) => MONTH.format(new Date(`${m}-01T00:00:00Z`));
/** Two progress figures this far apart (in points) are worth a look. */
const DISAGREE = 10;

export function ProjectDashboardScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const dash = useQuery({
    queryKey: ['project-dashboard', projectId],
    queryFn: () => api.request<ProjectDashboard>(`/api/tenant/projects/${projectId}/dashboard`),
  });
  if (project.isPending || dash.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  if (dash.isError) return <Alert tone="danger">{describeError(dash.error)}</Alert>;
  const p = project.data;
  const d = dash.data;
  const t = d.progress.total;
  const earnedMargin = (Number(t.done) - Number(t.budgetDone)).toFixed(2);
  const hasContract = Number(d.money.contract) !== 0;
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
        title="Dashboard"
        subtitle={`${p.number} · ${p.name}, as of ${shortDate(d.asOf)}`}
        actions={
          <div className="flex gap-2 print:hidden">
            <Link
              to="/print/progress-report/$projectId"
              params={{ projectId: p.id }}
              className={printLink}
            >
              Client report
            </Link>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden /> Print
            </Button>
          </div>
        }
      />

      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 print:grid-cols-5"
        aria-label="Project figures"
      >
        <Tile label="Contract (BOQ)" testId="dash-contract">
          {formatInrShort(d.money.contract)}
          {d.money.contractValue && d.money.contractValue !== d.money.contract && (
            <Sub>contract value {formatInrShort(d.money.contractValue)}</Sub>
          )}
        </Tile>
        <Tile label="Planned margin" testId="dash-margin">
          {d.money.margin === null ? '-' : formatInrShort(d.money.margin)}
          {d.money.marginPct !== null && <Sub>{d.money.marginPct}% of the contract</Sub>}
        </Tile>
        <Tile label="Work done" testId="dash-done">
          {formatInrShort(t.done)}
          <Sub>{pct(t.pct)} physical</Sub>
        </Tile>
        <Tile label={`This month (from ${shortDate(d.progress.from)})`} testId="dash-period">
          {formatInrShort(t.period)}
        </Tile>
        <Tile label="Margin on work done" testId="dash-earned-margin">
          {formatInrShort(earnedMargin)}
          <Sub>at budget rates {formatInrShort(t.budgetDone)}</Sub>
        </Tile>
      </div>

      <Card
        title="Schedules"
        actions={
          <Link
            to="/projects/$projectId/macro"
            params={{ projectId }}
            className="text-sm text-accent hover:underline print:hidden"
          >
            Macro plan
          </Link>
        }
      >
        {d.schedules.length === 0 ? (
          <EmptyState title="No live schedules yet.">
            Start one from the project&apos;s page; its progress shows here.
          </EmptyState>
        ) : (
          <>
            <Table minWidth="52rem">
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Data date</th>
                  <th>Finish</th>
                  <th className="text-right" title="Where the baseline says the work should be">
                    Planned
                  </th>
                  <th className="text-right" title="What the planners report done">
                    Scheduled
                  </th>
                  <th
                    className="text-right"
                    title="Measured on the BOQ items its activities carry out"
                  >
                    Measured
                  </th>
                  <th className="text-right">Late / critical</th>
                </tr>
              </thead>
              <tbody aria-label="Schedules">
                {d.schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link
                        to="/programmes/$planId"
                        params={{ planId: s.id }}
                        className="text-accent hover:underline"
                      >
                        {s.name}
                      </Link>
                      <span className="block text-xs text-fg-muted">
                        {s.finished} done, {s.inProgress} going of {s.activities}
                      </span>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{shortDate(s.dataDate)}</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {shortDate(s.finish)}{' '}
                      {s.slipDays !== null && (
                        <Badge
                          tone={s.slipDays > 0 ? 'danger' : s.slipDays < 0 ? 'success' : 'neutral'}
                        >
                          {slip(s.slipDays)}
                        </Badge>
                      )}
                      {s.baselineName && (
                        <span className="block text-xs text-fg-muted">
                          {s.baselineName}: {shortDate(s.baselineFinish)}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums" data-testid="dash-planned">
                      {s.baselineName ? pct(s.plannedPct) : 'no baseline'}
                    </td>
                    <td className="text-right tabular-nums" data-testid="dash-scheduled">
                      {pct(s.scheduledPct)}
                    </td>
                    <td className="text-right tabular-nums" data-testid="dash-measured">
                      {Number(s.linkedValue) === 0 ? 'no items linked' : pct(s.measuredPct)}
                    </td>
                    <td className="text-right tabular-nums">
                      <span className={cx(s.lateToBaseline > 0 && 'text-danger')}>
                        {s.lateToBaseline}
                      </span>{' '}
                      / {s.critical}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Disagreements schedules={d.schedules} />
            <p className="mt-2 text-xs text-fg-muted">
              <b>Planned</b>: where the baseline says the work should be by the data date.{' '}
              <b>Scheduled</b>: what the planners report done, by working days. <b>Measured</b>: the
              physical progress of the BOQ items its activities carry out, by contract value. They
              are kept apart on purpose; when they disagree, one of them is wrong. <b>Late</b>:
              activities not finished whose baseline finish has passed.
            </p>
          </>
        )}
      </Card>

      <Card title="S-curve">
        {d.curve ? (
          <SCurve curve={d.curve} contract={d.money.contract} projectId={projectId} />
        ) : (
          <EmptyState title="Nothing to draw yet.">
            Link BOQ items to schedule activities (in an activity&apos;s panel) and measure work
            done in the contract BOQ.
          </EmptyState>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 print:grid-cols-2">
        <Card
          title={`Next ${d.lookahead.days} days`}
          actions={
            d.schedules.length === 1 && (
              <Link
                to="/programmes/$planId/lookahead"
                params={{ planId: d.schedules[0]!.id }}
                className="text-sm text-accent hover:underline print:hidden"
              >
                Full look-ahead
              </Link>
            )
          }
        >
          {d.lookahead.activities.length === 0 ? (
            <EmptyState title="Nothing on or due." />
          ) : (
            <Table minWidth="28rem">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th>Start</th>
                  <th>Finish</th>
                </tr>
              </thead>
              <tbody aria-label="Look-ahead">
                {d.lookahead.activities.slice(0, 25).map((a) => (
                  <tr key={`${a.planId}/${a.id}`}>
                    <td>
                      <span className="mr-2 font-mono text-xs">{a.code}</span>
                      {a.name} {a.critical && <Badge tone="danger">critical</Badge>}
                      {a.status === 'in_progress' && <Badge tone="accent">going</Badge>}
                      {d.schedules.length > 1 && (
                        <span className="block text-xs text-fg-muted">{a.schedule}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{shortDate(a.start)}</td>
                    <td className="whitespace-nowrap tabular-nums">{shortDate(a.finish)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {(d.lookahead.activities.length > 25 || d.lookahead.more) && (
            <p className="mt-2 text-xs text-fg-muted">
              The first 25 shown; the schedule&apos;s look-ahead lists them all.
            </p>
          )}
        </Card>
        <Card title="Next milestones">
          {d.milestones.length === 0 ? (
            <EmptyState title="No milestones still to come." />
          ) : (
            <Table minWidth="28rem">
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th>Date</th>
                  <th>Baseline</th>
                </tr>
              </thead>
              <tbody aria-label="Next milestones">
                {d.milestones.map((m) => (
                  <tr key={`${m.planId}/${m.id}`}>
                    <td>
                      <span className="mr-2 font-mono text-xs">{m.code}</span>
                      {m.name} {m.critical && <Badge tone="danger">critical</Badge>}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{shortDate(m.date)}</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {shortDate(m.baselineDate)}{' '}
                      {m.slipDays !== null && m.slipDays !== 0 && (
                        <span className={m.slipDays > 0 ? 'text-danger' : 'text-success'}>
                          {slip(m.slipDays)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {hasContract && (
        <Card
          title="Budget against contract, and work done"
          actions={
            <Link
              to="/projects/$projectId/progress"
              params={{ projectId }}
              className="text-sm text-accent hover:underline print:hidden"
            >
              Progress report
            </Link>
          }
        >
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Contract BOQ / section</th>
                <th className="text-right">Contract</th>
                <th className="text-right">Budget</th>
                <th className="text-right">Margin</th>
                <th className="text-right">Done</th>
                <th className="text-right">Physical</th>
              </tr>
            </thead>
            <tbody aria-label="Budget against contract">
              {d.money.boqs.map((b) => (
                <tr key={b.contractId} className="font-semibold">
                  <td>{b.name}</td>
                  <td className="text-right tabular-nums">{formatInr(b.contract)}</td>
                  <td className="text-right tabular-nums">{formatInr(b.budget)}</td>
                  <td className="text-right tabular-nums">{formatInr(b.margin)}</td>
                  <td colSpan={2} />
                </tr>
              ))}
              {d.progress.sections.map((s, i) => (
                <tr key={`${s.boq}-${s.code ?? ''}-${i}`}>
                  <td>
                    {s.code && <span className="mr-2 font-mono text-xs">{s.code}</span>}
                    {s.description}
                    {d.money.boqs.length > 1 && (
                      <span className="block text-xs text-fg-muted">{s.boq}</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(s.value)}</td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums">{formatInr(s.done)}</td>
                  <td className="text-right tabular-nums">{pct(s.pct)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/** Schedules whose progress figures disagree by more than DISAGREE points, said in words. */
function Disagreements({ schedules }: { schedules: ProjectDashboard['schedules'] }) {
  const notes = schedules.flatMap((s) => {
    const out: string[] = [];
    const sch = s.scheduledPct;
    const mea = Number(s.linkedValue) > 0 ? s.measuredPct : null;
    if (sch !== null && mea !== null && Math.abs(sch - mea) > DISAGREE)
      out.push(
        `${s.name}: the planners report ${pct(sch)} done, the measurements show ${pct(mea)}. Check the reported progress or the measurement book.`,
      );
    if (s.plannedPct !== null && sch !== null && s.plannedPct - sch > DISAGREE)
      out.push(`${s.name}: ${pct(sch)} done against ${pct(s.plannedPct)} planned by the baseline.`);
    return out;
  });
  if (!notes.length) return null;
  return (
    <Alert tone="warning">
      <ul className="list-inside list-disc" data-testid="dash-disagreements">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Alert>
  );
}

function SCurve({
  curve,
  contract,
  projectId,
}: {
  curve: NonNullable<ProjectDashboard['curve']>;
  contract: string;
  projectId: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const line = (name: string, data: (number | null)[], dashed = false) => ({
      name,
      type: 'line',
      data,
      showSymbol: data.length < 30,
      connectNulls: false,
      lineStyle: { type: dashed ? 'dashed' : 'solid' },
    });
    return {
      grid: { left: 70, right: 16, top: 56, bottom: 30 },
      xAxis: { type: 'category', data: curve.months.map(monthLabel) },
      yAxis: valueAxis('money'),
      series: [
        ...(curve.planned ? [line('Planned (baseline)', curve.planned, true)] : []),
        line('Forecast (schedule)', curve.forecast),
        line('Earned (measured)', curve.earned),
      ],
    };
  }, [curve]);
  const linkedShare =
    Number(contract) > 0
      ? Math.round((Number(curve.linkedValue) / Number(contract)) * 1000) / 10
      : 0;
  return (
    <div className="space-y-2">
      <ChartFigure
        title="S-curve"
        option={option}
        height={280}
        heading="Month"
        measures="money"
        label="S-curve: planned, forecast and earned value by month"
        drill={() => `/projects/${projectId}/progress`}
      />
      <p className="text-xs text-fg-muted" data-testid="dash-coverage">
        Planned and forecast spread the {formatInr(curve.linkedValue)} of contract work linked to
        schedule activities ({linkedShare}% of {formatInr(contract)}), over their working days.
        Earned is all work measured, linked or not, at contract rates. Click a month for the
        progress report.
        {linkedShare < 90 &&
          ' Link more items to activities for the planned and forecast curves to cover the contract.'}
      </p>
    </div>
  );
}

function Tile({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

const Sub = ({ children }: { children: ReactNode }) => (
  <span className="block text-xs font-normal text-fg-muted">{children}</span>
);
