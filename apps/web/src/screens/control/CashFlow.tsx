// Cash flow (docs/wave4-plan.md step 2): a project's, or the company's, money in and out by month or week: actual
// back, forecast ahead from the cash terms (or the defaults), with the running position.
import {
  Alert,
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
import { today, useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';

interface Period {
  key: string;
  label: string;
  actual: boolean;
}
interface Flow {
  periods: Period[];
  lines: { kind: string; direction: 'in' | 'out'; label: string; values: Record<string, string> }[];
  totals: { in: Record<string, string>; out: Record<string, string>; net: Record<string, string> };
  position: Record<string, string>;
  detail: { date: string; kind: string; label: string; amount: string }[];
  opening: string;
  notes: string[];
  mayEdit: boolean;
}
interface Terms {
  certifyDays: number;
  clientPayDays: number;
  clientTdsPct: string;
  supplierDays: number;
  costDays: number;
  set: boolean;
  rowVersion: number | null;
}
const money = (v: string | undefined) => (v && Number(v) !== 0 ? formatInr(v) : '');

export function CashFlowScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [scope, setScope] = useState('company');
  const [by, setBy] = useState<'month' | 'week'>('month');
  const [asOf, setAsOf] = useState(today());
  return (
    <div className="space-y-5">
      <PageHeader
        title="Cash flow"
        subtitle="Money in and out: actual back, forecast ahead."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Whose" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="company">The company</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label="By" value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
              <option value="month">By month</option>
              <option value="week">By week</option>
            </Select>
            <Input
              type="date"
              aria-label="As of"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
        }
      />
      {scope === 'company' ? (
        <CompanyCash by={by} asOf={asOf} />
      ) : (
        <ProjectCash key={scope} projectId={scope} by={by} asOf={asOf} />
      )}
    </div>
  );
}

function CompanyCash({ by, asOf }: { by: string; asOf: string }) {
  const { company } = useCompany();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['cash-flow', 'company', company?.id, by, asOf],
    enabled: !!company,
    queryFn: () =>
      api.request<
        Flow & {
          cashNow: string;
          overheadsMonthly: string;
          projects: {
            project: { number: string; name: string };
            in: string;
            out: string;
            net: string;
          }[];
        }
      >(`/api/tenant/accounts/cash-flow?entityId=${company!.id}&by=${by}&asOf=${asOf}`),
  });
  const [overheads, setOverheads] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!company || q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title={`${company.name}: bank and cash ${formatInr(d.cashNow)} before ${asOf}`}>
        <CashTable d={d} />
        {d.notes.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted">
            {d.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </Card>
      {d.projects.length > 0 && (
        <Card title="Forecast by project">
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Project</th>
                <th className="text-right">In</th>
                <th className="text-right">Out</th>
                <th className="text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {d.projects.map((p) => (
                <tr key={p.project.number}>
                  <td>
                    {p.project.number} {p.project.name}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(p.in)}</td>
                  <td className="text-right tabular-nums">{formatInr(p.out)}</td>
                  <td className="text-right tabular-nums">{formatInr(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {d.mayEdit && (
        <Card title="Company overheads">
          <form
            aria-label="Company overheads"
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api.request(`/api/tenant/accounts/cash-flow/${company.id}/overheads`, {
                  method: 'POST',
                  body: { amount: overheads || d.overheadsMonthly },
                });
                void qc.invalidateQueries({ queryKey: ['cash-flow'] });
              } catch (err) {
                setError(describeError(err));
              }
            }}
          >
            <Field label="Per month, not booked to projects">
              <Input
                inputMode="decimal"
                placeholder={d.overheadsMonthly}
                value={overheads}
                onChange={(e) => setOverheads(e.target.value)}
              />
            </Field>
            <Button type="submit">Save</Button>
          </form>
        </Card>
      )}
    </>
  );
}

function ProjectCash({ projectId, by, asOf }: { projectId: string; by: string; asOf: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['cash-flow', projectId, by, asOf],
    queryFn: () =>
      api.request<Flow & { terms: Terms }>(
        `/api/tenant/projects/${projectId}/cash-flow?by=${by}&asOf=${asOf}`,
      ),
  });
  const [error, setError] = useState<string | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const t = terms ?? d.terms;
  const num = (k: keyof Terms, label: string) => (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        max={365}
        value={String(t[k])}
        onChange={(e) => setTerms({ ...t, [k]: Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Cash flow">
        <CashTable d={d} />
        {d.notes.map((n) => (
          <p key={n} className="mt-2 text-xs text-fg-muted">
            {n}
          </p>
        ))}
      </Card>
      <Card title={d.terms.set ? 'Cash terms' : 'Cash terms (the defaults)'}>
        <form
          aria-label="Cash terms"
          className="grid gap-3 sm:grid-cols-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api.request(`/api/tenant/projects/${projectId}/cash-terms`, {
                method: 'POST',
                body: {
                  certifyDays: t.certifyDays,
                  clientPayDays: t.clientPayDays,
                  clientTdsPct: t.clientTdsPct,
                  supplierDays: t.supplierDays,
                  costDays: t.costDays,
                  rowVersion: d.terms.rowVersion,
                },
              });
              setTerms(null);
              void qc.invalidateQueries({ queryKey: ['cash-flow'] });
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          {num('certifyDays', 'Days to certify')}
          {num('clientPayDays', 'Days to pay after')}
          <Field label="Client TDS %">
            <Input
              inputMode="decimal"
              value={t.clientTdsPct}
              onChange={(e) => setTerms({ ...t, clientTdsPct: e.target.value })}
            />
          </Field>
          {num('supplierDays', 'Suppliers paid after (days)')}
          {num('costDays', 'Other cost paid after (days)')}
          {d.mayEdit && (
            <div className="flex items-end">
              <Button type="submit">Save terms</Button>
            </div>
          )}
        </form>
      </Card>
      {d.detail.length > 0 && (
        <Card title="What the forecast is made of">
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Expected</th>
                <th>What</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.detail.map((x, i) => (
                <tr key={i}>
                  <td>{x.date}</td>
                  <td>
                    {d.lines.find((l) => l.kind === x.kind)?.label}: {x.label}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function CashTable({ d }: { d: Flow }) {
  const cols = d.periods.filter(
    (p) => p.key !== 'later' || Number(d.totals.in.later) || Number(d.totals.out.later),
  );
  const row = (label: string, values: Record<string, string>, strong = false) => (
    <tr key={label} aria-label={label} className={strong ? 'font-medium' : ''}>
      <th scope="row" className="whitespace-nowrap text-left font-normal">
        {label}
      </th>
      {cols.map((p) => (
        <td key={p.key} className={`text-right tabular-nums ${p.actual ? 'bg-surface-muted' : ''}`}>
          {money(values[p.key])}
        </td>
      ))}
    </tr>
  );
  return (
    <Table minWidth={`${12 + cols.length * 6}rem`}>
      <thead>
        <tr>
          <th />
          {cols.map((p) => (
            <th key={p.key} className={`text-right ${p.actual ? 'bg-surface-muted' : ''}`}>
              {p.label}
              <span className="block text-[10px] font-normal text-fg-subtle">
                {p.actual ? 'actual' : 'forecast'}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody data-testid="cash-table">
        {d.lines.filter((l) => l.direction === 'in').map((l) => row(l.label, l.values))}
        {row('Total in', d.totals.in, true)}
        {d.lines.filter((l) => l.direction === 'out').map((l) => row(l.label, l.values))}
        {row('Total out', d.totals.out, true)}
        {row('Net', d.totals.net, true)}
        {row('Position', d.position, true)}
      </tbody>
    </Table>
  );
}
