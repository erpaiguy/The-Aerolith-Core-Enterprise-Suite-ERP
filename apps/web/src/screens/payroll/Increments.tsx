// Salary revisions in bulk (docs/wave7-plan.md step 7c.7): everyone in service on a day with their current gross; a
// percentage per person (or one for all), reviewed and applied together as new salaries from that day.
import {
  Alert,
  Button,
  Card,
  Input,
  PageHeader,
  Spinner,
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { CompanyPicker } from '../accounts/Vouchers';

interface Sheet {
  rows: {
    employee: { id: string; code: string; name: string; designation: string | null };
    salary: { from: string; gross: string } | null;
  }[];
}
const nextMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

export function IncrementsScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const [from, setFrom] = useState(nextMonth());
  const [pct, setPct] = useState<Record<string, string>>({});
  const [all, setAll] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = ['increments', company?.id, from];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Sheet>(`/api/tenant/payroll/increments?entityId=${company!.id}&from=${from}`),
    enabled: !!company && /^\d{4}-\d{2}-\d{2}$/.test(from),
  });
  const of = (id: string) => pct[id] ?? all;
  const confirm = useConfirm();
  const apply = async () => {
    setError(null);
    setDone(null);
    const rows = (q.data?.rows ?? [])
      .filter((r) => r.salary && Number(of(r.employee.id)) > 0)
      .map((r) => ({ employeeId: r.employee.id, pct: of(r.employee.id) }));
    if (
      !(await confirm({
        title: `Apply increments for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}?`,
        body: `Each gets a new salary from ${shortDate(from)}, which payroll runs from then on use.`,
        confirmLabel: 'Apply the increments',
        tone: 'primary',
      }))
    )
      return;
    try {
      qc.setQueryData(
        key,
        await api.request<Sheet>('/api/tenant/payroll/increments', {
          method: 'POST',
          body: { entityId: company!.id, from, rows },
        }),
      );
      setPct({});
      setAll('');
      setDone(
        `New salaries from ${shortDate(from)} for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`,
      );
      toast.success(
        `Increments applied for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`,
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Increments"
        subtitle="Everyone in service, their salary now, and the increment from a date: reviewed, then applied together."
        actions={
          <div className="flex flex-wrap gap-2">
            {company ? <CompanyPicker value={company.id} onChange={choose} /> : null}
            <Input
              type="date"
              aria-label="From"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
        }
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <Card
          title={`Increment sheet from ${shortDate(from)}`}
          actions={
            <label className="flex items-center gap-2 text-sm">
              Everyone %
              <Input
                aria-label="Everyone %"
                className="w-20 text-right"
                inputMode="decimal"
                value={all}
                onChange={(e) => setAll(e.target.value)}
              />
            </label>
          }
        >
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Salary since</th>
                <th className="text-right">Gross now</th>
                <th className="text-right">Increment %</th>
                <th className="text-right">Gross after</th>
              </tr>
            </thead>
            <tbody aria-label="Increment sheet">
              {q.data.rows.map((r) => {
                const p = Number(of(r.employee.id) || 0);
                return (
                  <tr key={r.employee.id}>
                    <td>
                      <span className="font-mono text-xs">{r.employee.code}</span> {r.employee.name}
                      {r.employee.designation ? (
                        <div className="text-xs text-fg-muted">{r.employee.designation}</div>
                      ) : null}
                    </td>
                    <td>{r.salary ? shortDate(r.salary.from) : 'No salary'}</td>
                    <td className="text-right">{r.salary ? formatInr(r.salary.gross) : '—'}</td>
                    <td className="text-right">
                      {r.salary ? (
                        <Input
                          aria-label={`Increment %, ${r.employee.name}`}
                          className="w-20 text-right"
                          inputMode="decimal"
                          value={pct[r.employee.id] ?? all}
                          onChange={(e) => setPct({ ...pct, [r.employee.id]: e.target.value })}
                        />
                      ) : null}
                    </td>
                    <td className="text-right">
                      {r.salary && p > 0
                        ? formatInr(String(Number(r.salary.gross) * (1 + p / 100)))
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {done ? <Alert tone="success">{done}</Alert> : null}
          <div className="mt-3">
            <Button onClick={() => void apply()}>Apply the increments</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
