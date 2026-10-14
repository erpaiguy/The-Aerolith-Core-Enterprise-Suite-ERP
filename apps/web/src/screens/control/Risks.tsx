// The risk register (docs/wave4-plan.md step 6), for a project or the company: risks by score with their expected
// value and mitigation actions, the heat map, and the project's contingency drawn down against risks that occur.
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
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';

interface Reg {
  scales: {
    probability: { level: number; label: string; pct: number }[];
    impact: { level: number; label: string }[];
  };
  risks: {
    id: string;
    number: string;
    category: string;
    event: string;
    cause: string;
    effect: string;
    probability: number;
    impact: number;
    costImpact: string;
    timeImpact: number;
    owner: string | null;
    status: string;
    score: number;
    band: string;
    expectedValue: string;
    rowVersion: number;
    actions: {
      id: string;
      action: string;
      dueOn: string | null;
      doneOn: string | null;
      overdue: boolean;
    }[];
  }[];
  heatMap: number[][];
  top: { number: string; event: string; score: number; band: string; expectedValue: string }[];
  openExpectedValue: string;
  contingency: {
    held: string;
    drawn: string;
    remaining: string;
    draws: { risk: string; amount: string; drawnOn: string; note: string }[];
  } | null;
  mayForecast: boolean;
}
const BAND: Record<string, 'success' | 'warning' | 'danger' | 'accent'> = {
  low: 'success',
  medium: 'accent',
  high: 'warning',
  extreme: 'danger',
};
const CELL = (s: number) =>
  s <= 4 ? 'bg-success/15' : s <= 9 ? 'bg-info/15' : s <= 16 ? 'bg-warning/20' : 'bg-danger/20';
const CATEGORIES = ['commercial', 'design', 'site', 'safety', 'regulatory', 'schedule', 'other'];

export function RisksScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [scope, setScope] = useProjectParam();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Risk register"
        subtitle="Risks by score and expected value, their mitigation, and the contingency held against them."
        actions={
          <Select aria-label="Whose" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Choose…</option>
            <option value="company">The company</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        }
      />
      {scope && <Register key={scope} projectId={scope === 'company' ? null : scope} />}
    </div>
  );
}

function Register({ projectId }: { projectId: string | null }) {
  const qc = useQueryClient();
  const path = projectId ? `/api/tenant/projects/${projectId}/risks` : '/api/tenant/risks';
  const key = ['risks', projectId];
  const r = useQuery({ queryKey: key, queryFn: () => api.request<Reg>(path) });
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    category: 'site',
    event: '',
    cause: '',
    effect: '',
    probability: '3',
    impact: '3',
    costImpact: '',
    timeImpact: '',
  });
  const [action, setAction] = useState<Record<string, string>>({});
  const [held, setHeld] = useState('');
  const [draw, setDraw] = useState<Record<string, string>>({});
  const call = async (p: string, body: object) => {
    setError(null);
    try {
      await api.request(p, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const pLabel = (n: number) => d.scales.probability.find((p) => p.level === n)?.label ?? String(n);
  const iLabel = (n: number) => d.scales.impact.find((p) => p.level === n)?.label ?? String(n);
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Heat map (open risks)">
          <table
            className="w-full text-center text-xs"
            aria-label="Heat map"
            data-testid="heat-map"
          >
            <tbody>
              {d.heatMap.map((row, i) => (
                <tr key={i}>
                  <th scope="row" className="pr-2 text-right font-normal text-fg-muted">
                    {iLabel(5 - i)}
                  </th>
                  {row.map((n, j) => (
                    <td key={j} className={`h-10 border border-line ${CELL((5 - i) * (j + 1))}`}>
                      {n || ''}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td />
                {[1, 2, 3, 4, 5].map((p) => (
                  <td key={p} className="pt-1 text-fg-muted">
                    {pLabel(p)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </Card>
        <Card title="Top risks">
          <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="top-risks">
            {d.top.map((t) => (
              <li key={t.number}>
                {t.number} {t.event} <Badge tone={BAND[t.band] ?? 'neutral'}>{t.score}</Badge>{' '}
                <span className="text-fg-muted">{formatInr(t.expectedValue)} expected</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-sm">
            Expected value of open risks: {formatInr(d.openExpectedValue)}
          </p>
          {d.contingency && (
            <p className="text-sm" data-testid="contingency">
              Contingency {formatInr(d.contingency.held)}, drawn {formatInr(d.contingency.drawn)},
              remaining {formatInr(d.contingency.remaining)}
            </p>
          )}
          {d.contingency && d.mayForecast && (
            <form
              aria-label="Contingency"
              className="mt-2 flex items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await call(`/api/tenant/projects/${projectId}/contingency`, { held }))
                  setHeld('');
              }}
            >
              <Field label="Contingency held (₹)">
                <Input
                  inputMode="decimal"
                  value={held}
                  placeholder={d.contingency.held}
                  onChange={(e) => setHeld(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" variant="secondary">
                Set
              </Button>
            </form>
          )}
        </Card>
      </div>

      <Card title="Risks">
        {d.risks.length > 0 && (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>No.</th>
                <th>Risk</th>
                <th>Score</th>
                <th className="text-right">Cost / time</th>
                <th className="text-right">Expected</th>
                <th>Status</th>
                <th>Mitigation</th>
              </tr>
            </thead>
            <tbody>
              {d.risks.map((x) => (
                <tr key={x.id} aria-label={x.number}>
                  <td>{x.number}</td>
                  <td>
                    {x.event}
                    <span className="block text-xs text-fg-muted">
                      {x.category} · {pLabel(x.probability)} × {iLabel(x.impact)}
                      {x.owner && ` · ${x.owner}`}
                    </span>
                  </td>
                  <td>
                    <Badge tone={BAND[x.band] ?? 'neutral'}>
                      {x.score} {x.band}
                    </Badge>
                  </td>
                  <td className="text-right tabular-nums">
                    {formatInr(x.costImpact)}
                    {x.timeImpact > 0 && ` · ${x.timeImpact} d`}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(x.expectedValue)}</td>
                  <td>
                    <Select
                      aria-label={`Status, ${x.number}`}
                      value={x.status}
                      onChange={(e) =>
                        void call(`/api/tenant/risks/${x.id}`, {
                          category: x.category,
                          cause: x.cause,
                          event: x.event,
                          effect: x.effect,
                          probability: x.probability,
                          impact: x.impact,
                          costImpact: x.costImpact,
                          timeImpact: x.timeImpact,
                          status: e.target.value,
                          rowVersion: x.rowVersion,
                        })
                      }
                    >
                      <option value="open">open</option>
                      <option value="occurred">occurred</option>
                      <option value="closed">closed</option>
                    </Select>
                    {x.status === 'occurred' && d.contingency && d.mayForecast && (
                      <span className="mt-1 flex gap-1">
                        <Input
                          aria-label={`Draw contingency, ${x.number}`}
                          className="w-24"
                          value={draw[x.id] ?? ''}
                          onChange={(e) => setDraw({ ...draw, [x.id]: e.target.value })}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={async () => {
                            if (
                              await call(`/api/tenant/risks/${x.id}/draws`, {
                                amount: draw[x.id],
                                date: today(),
                              })
                            )
                              setDraw({ ...draw, [x.id]: '' });
                          }}
                        >
                          Draw
                        </Button>
                      </span>
                    )}
                  </td>
                  <td>
                    <ul className="text-xs">
                      {x.actions.map((a) => (
                        <li key={a.id} className={a.overdue ? 'text-danger' : ''}>
                          {a.action}
                          {a.dueOn && ` · by ${a.dueOn}`}
                          {a.doneOn ? (
                            ' · done'
                          ) : (
                            <button
                              type="button"
                              className="ml-1 underline"
                              onClick={() =>
                                void call(`/api/tenant/risk-actions/${a.id}/done`, { on: today() })
                              }
                            >
                              done
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <form
                      aria-label={`Mitigation for ${x.number}`}
                      className="mt-1 flex gap-1"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await call(`/api/tenant/risks/${x.id}/actions`, {
                            action: action[x.id] ?? '',
                            dueOn: null,
                          })
                        )
                          setAction({ ...action, [x.id]: '' });
                      }}
                    >
                      <Input
                        aria-label={`New action, ${x.number}`}
                        className="w-40"
                        value={action[x.id] ?? ''}
                        onChange={(e) => setAction({ ...action, [x.id]: e.target.value })}
                      />
                      <Button type="submit" variant="ghost">
                        Add
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form
          aria-label="Raise a risk"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await call(path, {
                category: form.category,
                event: form.event,
                cause: form.cause,
                effect: form.effect,
                probability: Number(form.probability),
                impact: Number(form.impact),
                costImpact: form.costImpact || '0',
                timeImpact: Number(form.timeImpact || 0),
              })
            )
              setForm({
                ...form,
                event: '',
                cause: '',
                effect: '',
                costImpact: '',
                timeImpact: '',
              });
          }}
        >
          <Field label="Risk">
            <Input
              value={form.event}
              onChange={(e) => setForm({ ...form, event: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="Cause">
            <Input
              value={form.cause}
              onChange={(e) => setForm({ ...form, cause: e.target.value })}
            />
          </Field>
          <Field label="Effect">
            <Input
              value={form.effect}
              onChange={(e) => setForm({ ...form, effect: e.target.value })}
            />
          </Field>
          <Field label="Category">
            <Select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Probability">
            <Select
              value={form.probability}
              onChange={(e) => setForm({ ...form, probability: e.target.value })}
            >
              {d.scales.probability.map((p) => (
                <option key={p.level} value={p.level}>
                  {p.level} {p.label} ({p.pct}%)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Impact">
            <Select
              value={form.impact}
              onChange={(e) => setForm({ ...form, impact: e.target.value })}
            >
              {d.scales.impact.map((p) => (
                <option key={p.level} value={p.level}>
                  {p.level} {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cost impact (₹)">
            <Input
              inputMode="decimal"
              value={form.costImpact}
              onChange={(e) => setForm({ ...form, costImpact: e.target.value })}
            />
          </Field>
          <Field label="Time impact (days)">
            <Input
              inputMode="numeric"
              value={form.timeImpact}
              onChange={(e) => setForm({ ...form, timeImpact: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Raise</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
