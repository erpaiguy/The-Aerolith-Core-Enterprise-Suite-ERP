// Look-ahead with constraints (docs/wave8-plan.md step 8d.2): what each coming activity still waits for and who
// clears it by when; the week's work plan from what is ready; and, the week closed, the percent plan complete (PPC)
// week by week with the reasons commitments were missed.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { today } from '../accounts/model';
import { ChartFigure } from '../charts/ChartFigure';
import type { ChartOption } from '../charts/EChart';
import { valueAxis } from '../charts/measure';
import { describeError } from '../lib/format';

const KINDS = ['drawings', 'material', 'front', 'approvals', 'labour', 'equipment', 'other'];
const REASONS = [...KINDS.filter((k) => k !== 'other'), 'weather', 'predecessor', 'other'];
const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

interface Readiness {
  from: string;
  to: string;
  activities: {
    id: string;
    code: string;
    name: string;
    start: string;
    finish: string;
    open: number;
    overdue: number;
    ready: boolean;
  }[];
}
interface Constraint {
  id: string;
  activityId: string;
  activityCode: string;
  activity: string;
  kind: string;
  description: string;
  owner: string | null;
  dueOn: string;
  clearedOn: string | null;
  overdue: boolean;
}
interface Week {
  weekStart: string;
  closed: boolean;
  ppc: number | null;
  commitments: {
    id: string;
    activityCode: string | null;
    what: string;
    done: boolean | null;
    missReason: string | null;
  }[];
}

export function MakeReadyScreen({ planId }: { planId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const ready = useQuery({
    queryKey: ['readiness', planId],
    queryFn: () => api.request<Readiness>(`/api/tenant/programmes/${planId}/readiness?weeks=6`),
  });
  const log = useQuery({
    queryKey: ['constraints', planId],
    queryFn: () => api.request<Constraint[]>(`/api/tenant/programmes/${planId}/constraints`),
  });
  const [weekStart, setWeekStart] = useState(mondayOf(today()));
  const week = useQuery({
    queryKey: ['weekly-plan', planId, weekStart],
    queryFn: () =>
      api.request<Week>(`/api/tenant/programmes/${planId}/weekly-plan?week=${weekStart}`),
  });
  const trend = useQuery({
    queryKey: ['ppc', planId],
    queryFn: () =>
      api.request<{
        weeks: { weekStart: string; ppc: number | null }[];
        reasons: { reason: string; n: number }[];
      }>(`/api/tenant/programmes/${planId}/ppc`),
  });
  const refresh = () =>
    Promise.all(
      [
        ['readiness', planId],
        ['constraints', planId],
        ['weekly-plan', planId],
        ['ppc', planId],
      ].map((k) => qc.invalidateQueries({ queryKey: k })),
    );
  const run = async (path: string, body: object, done: string) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      await refresh();
      toast.success(done);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const [c, setC] = useState({ activityId: '', kind: 'drawings', description: '', dueOn: today() });
  const [what, setWhat] = useState({ activityId: '', what: '' });
  const [results, setResults] = useState<Record<string, { done: boolean; missReason: string }>>({});

  const addConstraint = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(`/api/tenant/programmes/${planId}/constraints`, c, 'Constraint added'))
      setC({ ...c, description: '' });
  };
  const commit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await run(
        `/api/tenant/programmes/${planId}/weekly-plan`,
        {
          weekStart,
          items: [{ activityId: what.activityId || null, what: what.what }],
        },
        'Commitment added',
      )
    )
      setWhat({ activityId: '', what: '' });
  };
  const close = async () => {
    const items = week.data?.commitments ?? [];
    const missed = items.filter((x) => results[x.id]?.done === false).length;
    if (
      !(await confirm({
        title: `Close the week of ${weekStart}?`,
        body: `${items.length - missed} of ${items.length} commitments done. The week's PPC is fixed and its plan can no longer be changed.`,
        confirmLabel: 'Close the week',
        tone: 'danger',
      }))
    )
      return;
    await run(
      `/api/tenant/programmes/${planId}/weekly-plan/close`,
      {
        weekStart,
        results: items.map((x) => ({
          id: x.id,
          done: results[x.id]?.done ?? true,
          missReason: results[x.id]?.done === false ? results[x.id]?.missReason || 'other' : null,
        })),
      },
      `Week of ${weekStart} closed`,
    );
  };

  const option: ChartOption | null = trend.data
    ? {
        grid: { top: 56, bottom: 28, left: 48, right: 16 },
        xAxis: { type: 'category', data: trend.data.weeks.map((w) => w.weekStart) },
        yAxis: valueAxis('pct', { min: 0, max: 100 }),
        series: [
          {
            name: 'PPC',
            type: 'line',
            data: trend.data.weeks.map((w) => w.ppc),
            markLine: {
              symbol: 'none',
              data: [{ yAxis: 80, name: 'Aim' }],
              label: { formatter: 'Aim {c}%' },
              lineStyle: { type: 'dashed' },
            },
          },
        ],
      }
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Look-ahead and weekly plan"
        subtitle="What the coming work waits for, what the site commits to each week, and how much of it got done."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title={ready.data ? `Coming up, ${ready.data.from} to ${ready.data.to}` : 'Coming up'}>
        {ready.isPending ? (
          <Spinner />
        ) : ready.isError ? (
          <Alert tone="danger">{describeError(ready.error)}</Alert>
        ) : (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Starts</th>
                <th>Waits on</th>
              </tr>
            </thead>
            <tbody aria-label="Readiness">
              {ready.data.activities.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.code} {a.name}
                  </td>
                  <td>{a.start}</td>
                  <td>
                    {a.ready ? (
                      <Badge tone="success">Ready</Badge>
                    ) : (
                      <Badge tone={a.overdue ? 'danger' : 'warning'}>
                        {a.open} open{a.overdue ? `, ${a.overdue} late` : ''}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Make-ready log">
        <form
          className="mb-3 grid gap-3 md:grid-cols-5"
          aria-label="New constraint"
          onSubmit={(e) => void addConstraint(e)}
        >
          <Field label="Activity">
            <Select
              value={c.activityId}
              onChange={(e) => setC({ ...c, activityId: e.target.value })}
              required
            >
              <option value="">Choose</option>
              {(ready.data?.activities ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Waits on">
            <Select value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <Field label="What">
            <Input
              value={c.description}
              onChange={(e) => setC({ ...c, description: e.target.value })}
              required
            />
          </Field>
          <Field label="Clear by">
            <Input
              type="date"
              value={c.dueOn}
              onChange={(e) => setC({ ...c, dueOn: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </div>
        </form>
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Waits on</th>
              <th>Clear by</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Constraints">
            {(log.data ?? []).map((x) => (
              <tr key={x.id}>
                <td>{x.activityCode}</td>
                <td>
                  <Badge tone="neutral">{x.kind}</Badge> {x.description}
                  {x.owner && <span className="text-xs text-fg-muted"> · {x.owner}</span>}
                </td>
                <td className={x.overdue ? 'text-danger' : ''}>{x.dueOn}</td>
                <td className="text-right">
                  {x.clearedOn ? (
                    <span className="text-sm text-fg-muted">cleared {x.clearedOn}</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        void run(
                          `/api/tenant/constraints/${x.id}/clear`,
                          { on: today() },
                          'Constraint cleared',
                        )
                      }
                    >
                      Clear
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card
        title={`Week of ${weekStart}${week.data?.ppc !== null && week.data?.ppc !== undefined ? `: PPC ${week.data.ppc}%` : ''}`}
        actions={
          <Input
            type="date"
            aria-label="Week"
            value={weekStart}
            onChange={(e) => e.target.value && setWeekStart(mondayOf(e.target.value))}
          />
        }
      >
        {!week.data?.closed && (
          <form
            className="mb-3 grid gap-3 md:grid-cols-3"
            aria-label="Commit"
            onSubmit={(e) => void commit(e)}
          >
            <Field label="Activity">
              <Select
                value={what.activityId}
                onChange={(e) => setWhat({ ...what, activityId: e.target.value })}
              >
                <option value="">Not on the schedule</option>
                {(ready.data?.activities ?? [])
                  .filter((a) => a.ready)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Commitment">
              <Input
                value={what.what}
                onChange={(e) => setWhat({ ...what, what: e.target.value })}
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="secondary">
                Commit
              </Button>
            </div>
          </form>
        )}
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Commitment</th>
              <th>Done</th>
              <th>If missed, why</th>
            </tr>
          </thead>
          <tbody aria-label="Commitments">
            {(week.data?.commitments ?? []).map((x) => (
              <tr key={x.id}>
                <td>
                  {x.activityCode && (
                    <span className="text-xs text-fg-muted">{x.activityCode} </span>
                  )}
                  {x.what}
                </td>
                <td>
                  {week.data!.closed ? (
                    x.done ? (
                      <Badge tone="success">done</Badge>
                    ) : (
                      <Badge tone="danger">missed</Badge>
                    )
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Done: ${x.what}`}
                      checked={results[x.id]?.done ?? true}
                      onChange={(e) =>
                        setResults({
                          ...results,
                          [x.id]: { missReason: '', ...results[x.id], done: e.target.checked },
                        })
                      }
                    />
                  )}
                </td>
                <td>
                  {week.data!.closed ? (
                    (x.missReason ?? '')
                  ) : results[x.id]?.done === false ? (
                    <Select
                      aria-label={`Why missed: ${x.what}`}
                      value={results[x.id]?.missReason ?? ''}
                      onChange={(e) =>
                        setResults({
                          ...results,
                          [x.id]: { done: false, missReason: e.target.value },
                        })
                      }
                    >
                      <option value="">Choose</option>
                      {REASONS.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!week.data?.closed && (week.data?.commitments.length ?? 0) > 0 && (
          <Button type="button" className="mt-3" onClick={() => void close()}>
            Close the week
          </Button>
        )}
      </Card>

      {trend.data && trend.data.weeks.length > 0 && option && (
        <Card title="Percent plan complete">
          <ChartFigure
            title="Percent plan complete"
            label="Percent plan complete week by week"
            heading="Week starting"
            option={option}
            measures="pct"
            onPick={(e) => {
              const w = trend.data.weeks[e.dataIndex];
              if (w) setWeekStart(w.weekStart);
            }}
          />
          <p className="mt-1 text-xs text-fg-muted">Click a week for its commitments.</p>
          {trend.data.reasons.length > 0 && (
            <p className="mt-2 text-sm text-fg-muted">
              Missed for: {trend.data.reasons.map((r) => `${r.reason} (${r.n})`).join(', ')}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
