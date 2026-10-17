// Payroll gaps on the employee's page (docs/wave8-plan.md step 8c.4): overtime approved by the day, loans and salary
// advances with what is recovered, and the old regime's tax declarations with their proofs.
import { Alert, Badge, Button, Card, Field, Input, Select, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';

const fyOf = (d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);

function useAct() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const act = async (key: unknown[], path: string, body: object, method = 'POST') => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request(path, { method, body }));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  return { act, error };
}

export function EmployeePayCard({ employeeId }: { employeeId: string }) {
  const month = today().slice(0, 7);
  const fy = fyOf(today());
  const chart = useChart({ ifAllowed: true });
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const otKey = ['pay-ot', employeeId, month];
  const loanKey = ['pay-loans', employeeId];
  const declKey = ['pay-decl', employeeId, fy];
  const ot = useQuery({
    queryKey: otKey,
    queryFn: () =>
      api.request<{ id: string; day: string; hours: string; reason: string }[]>(
        `/api/tenant/payroll/employees/${employeeId}/overtime?month=${month}`,
      ),
    retry: false,
  });
  const loans = useQuery({
    queryKey: loanKey,
    queryFn: () =>
      api.request<
        {
          id: string;
          kind: string;
          principal: string;
          emi: string;
          firstMonth: string;
          givenOn: string;
          recovered: string;
          voucher: string;
        }[]
      >(`/api/tenant/payroll/employees/${employeeId}/loans`),
    retry: false,
  });
  const decl = useQuery({
    queryKey: declKey,
    queryFn: () =>
      api.request<{
        counted: string;
        rows: {
          id: string;
          section: string;
          description: string;
          declared: string;
          proved: string | null;
        }[];
      }>(`/api/tenant/payroll/employees/${employeeId}/declarations?year=${fy}`),
    retry: false,
  });
  const { act, error } = useAct();
  const [o, setO] = useState({ day: today(), hours: '', reason: '' });
  const [l, setL] = useState({
    kind: 'advance',
    principal: '',
    emi: '',
    firstMonth: month,
    givenOn: today(),
    bankAccountId: '',
  });
  const [d, setD] = useState({ section: '80C', description: '', declared: '' });
  const [proof, setProof] = useState<Record<string, string>>({});
  if (ot.isError) return null; // no payroll permission
  const submit = (fn: () => Promise<boolean>) => (e: FormEvent) => {
    e.preventDefault();
    void fn();
  };
  return (
    <Card title="Overtime, loans and tax declarations">
      {error && <Alert tone="danger">{error}</Alert>}
      <h3 className="text-sm font-semibold">Overtime this month</h3>
      <ul className="mb-2 text-sm" aria-label="Overtime">
        {(ot.data ?? []).map((x) => (
          <li key={x.id}>
            {x.day}: {Number(x.hours)} hours {x.reason && `(${x.reason})`}
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3 md:grid-cols-4"
        aria-label="Add overtime"
        onSubmit={submit(() =>
          act(otKey, `/api/tenant/payroll/employees/${employeeId}/overtime`, o),
        )}
      >
        <Field label="Day">
          <Input type="date" value={o.day} onChange={(e) => setO({ ...o, day: e.target.value })} />
        </Field>
        <Field label="Hours">
          <Input
            inputMode="decimal"
            value={o.hours}
            onChange={(e) => setO({ ...o, hours: e.target.value })}
            required
          />
        </Field>
        <Field label="Reason">
          <Input value={o.reason} onChange={(e) => setO({ ...o, reason: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Approve overtime
          </Button>
        </div>
      </form>

      <h3 className="mt-5 text-sm font-semibold">Loans and salary advances</h3>
      {(loans.data ?? []).length ? (
        <Table minWidth="34rem">
          <thead>
            <tr>
              <th>Given</th>
              <th className="text-right">Amount</th>
              <th className="text-right">A month</th>
              <th className="text-right">Recovered</th>
            </tr>
          </thead>
          <tbody aria-label="Loans">
            {loans.data!.map((x) => (
              <tr key={x.id}>
                <td>
                  {x.kind === 'loan' ? 'Loan' : 'Advance'} on {x.givenOn}{' '}
                  <span className="text-xs text-fg-muted">{x.voucher}</span>
                </td>
                <td className="text-right">{rupees(x.principal)}</td>
                <td className="text-right">{rupees(x.emi)}</td>
                <td className="text-right">
                  {rupees(x.recovered)}{' '}
                  {Number(x.recovered) >= Number(x.principal) && (
                    <Badge tone="success">cleared</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      <form
        className="mt-2 grid gap-3 md:grid-cols-6"
        aria-label="Give a loan"
        onSubmit={submit(async () => {
          const ok = await act(loanKey, `/api/tenant/payroll/employees/${employeeId}/loans`, {
            ...l,
            bankAccountId: l.bankAccountId || banks[0]?.id,
          });
          if (ok) setL({ ...l, principal: '', emi: '' });
          return ok;
        })}
      >
        <Field label="Kind">
          <Select value={l.kind} onChange={(e) => setL({ ...l, kind: e.target.value })}>
            <option value="advance">Salary advance</option>
            <option value="loan">Loan</option>
          </Select>
        </Field>
        <Field label="Amount ₹">
          <Input
            inputMode="decimal"
            value={l.principal}
            onChange={(e) => setL({ ...l, principal: e.target.value })}
            required
          />
        </Field>
        <Field label="Recover a month ₹">
          <Input
            inputMode="decimal"
            value={l.emi}
            onChange={(e) => setL({ ...l, emi: e.target.value })}
            required
          />
        </Field>
        <Field label="From the month">
          <Input
            type="month"
            value={l.firstMonth}
            onChange={(e) => setL({ ...l, firstMonth: e.target.value })}
          />
        </Field>
        <Field label="Paid from">
          <Select
            value={l.bankAccountId || banks[0]?.id || ''}
            onChange={(e) => setL({ ...l, bankAccountId: e.target.value })}
          >
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Give
          </Button>
        </div>
      </form>

      <h3 className="mt-5 text-sm font-semibold">
        Tax declarations, {fy}-{String((fy + 1) % 100).padStart(2, '0')} (old regime)
      </h3>
      {decl.data?.rows.length ? (
        <Table minWidth="34rem">
          <thead>
            <tr>
              <th>Section</th>
              <th className="text-right">Declared</th>
              <th className="text-right">Proof shows</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Declarations">
            {decl.data.rows.map((x) => (
              <tr key={x.id}>
                <td>
                  {x.section} {x.description}
                </td>
                <td className="text-right">{rupees(x.declared)}</td>
                <td className="text-right">{x.proved === null ? '—' : rupees(x.proved)}</td>
                <td className="text-right">
                  <form
                    className="flex justify-end gap-2"
                    onSubmit={submit(() =>
                      act(declKey, `/api/tenant/payroll/declarations/${x.id}/verify`, {
                        proved: proof[x.id] ?? '',
                      }),
                    )}
                  >
                    <Input
                      aria-label={`Proof for ${x.section} ${x.description}`}
                      className="w-28"
                      inputMode="decimal"
                      value={proof[x.id] ?? ''}
                      onChange={(e) => setProof({ ...proof, [x.id]: e.target.value })}
                    />
                    <Button type="submit" variant="ghost">
                      Verify
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      {decl.data ? (
        <p className="mt-1 text-sm text-fg-muted">
          Counted against tax: {rupees(decl.data.counted)}
        </p>
      ) : null}
      <form
        className="mt-2 grid gap-3 md:grid-cols-4"
        aria-label="Declare"
        onSubmit={submit(async () => {
          const ok = await act(
            declKey,
            `/api/tenant/payroll/employees/${employeeId}/declarations`,
            {
              fyStart: fy,
              ...d,
            },
          );
          if (ok) setD({ ...d, description: '', declared: '' });
          return ok;
        })}
      >
        <Field label="Section">
          <Select value={d.section} onChange={(e) => setD({ ...d, section: e.target.value })}>
            {['80C', '80CCD1B', '80D', '24b', 'HRA', '80E', '80G', 'other'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
        <Field label="What">
          <Input
            value={d.description}
            onChange={(e) => setD({ ...d, description: e.target.value })}
          />
        </Field>
        <Field label="Declared ₹">
          <Input
            inputMode="decimal"
            value={d.declared}
            onChange={(e) => setD({ ...d, declared: e.target.value })}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Declare
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The Payment of Bonus Act for a year, at the percentage chosen. */
export function BonusCard({ entityId }: { entityId: string }) {
  const fy = fyOf(today());
  const [year, setYear] = useState(fy);
  const [pct, setPct] = useState('8.33');
  const q = useQuery({
    queryKey: ['pay-bonus', entityId, year, pct],
    queryFn: () =>
      api.request<{
        employees: {
          employeeId: string;
          code: string;
          name: string;
          eligibleMonths: number;
          base: number;
          bonus: number;
        }[];
        total: number;
      }>(`/api/tenant/payroll/bonus?entityId=${entityId}&year=${year}&pct=${pct}`),
    enabled: Number(pct) >= 8.33 && Number(pct) <= 20,
  });
  return (
    <Card
      title="Bonus (Payment of Bonus Act)"
      actions={
        <div className="flex gap-2">
          <Select
            aria-label="Year"
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {[fy - 1, fy].map((v) => (
              <option key={v} value={v}>
                {v}-{String((v + 1) % 100).padStart(2, '0')}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Bonus %"
            className="w-20"
            inputMode="decimal"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
          />
        </div>
      }
    >
      {q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : q.data ? (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="text-right">Months within ₹21,000</th>
              <th className="text-right">Counted on</th>
              <th className="text-right">Bonus</th>
            </tr>
          </thead>
          <tbody aria-label="Bonus">
            {q.data.employees.map((e) => (
              <tr key={e.employeeId}>
                <td>
                  {e.code} {e.name}
                </td>
                <td className="text-right">{e.eligibleMonths}</td>
                <td className="text-right">{rupees(String(e.base))}</td>
                <td className="text-right">{rupees(String(e.bonus))}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
