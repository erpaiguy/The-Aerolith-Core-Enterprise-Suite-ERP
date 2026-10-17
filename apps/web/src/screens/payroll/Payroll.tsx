// Payroll (docs/wave3-plan.md step 12a): the monthly runs, the compliance rules and pay components; a run worked,
// adjusted, approved, posted and paid with the bank's file; payslips to print; an employee's salary.
import { StatutoryDues } from './Statutory';
import { BonusCard } from './EmployeePay';
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
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import { today, useChart } from '../../accounts/model';
import { ApprovalSteps } from '../../approvals/ApprovalTrail';
import type { Approval } from '../../approvals/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { usePermission } from '../../session/permissions';
import { Books } from '../accounts/Vouchers';
import { printLink } from '../../print/Letterhead';

interface Component {
  id: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  inWages: boolean;
  taxable: boolean;
  prorated: boolean;
  active: boolean;
}
interface Rule {
  id: string;
  kind: string;
  stateCode: string | null;
  effectiveFrom: string;
  data: unknown;
  note: string;
}
interface Earning {
  code: string;
  name: string;
  full: number;
  amount: number;
  oneOff: boolean;
}
interface Pf {
  epfWages?: number;
  employee?: number;
  eps?: number;
  employerEpf?: number;
  edli?: number;
  admin?: number;
}
interface RunLine {
  employeeId: string;
  code: string;
  name: string;
  days: string;
  payableDays: string;
  earnings: Earning[];
  deductions: { code: string; name: string; amount: number }[];
  gross: string;
  wages: string;
  pf: Pf;
  esiEmployee: string;
  esiEmployer: string;
  pt: string;
  lwfEmployee: string;
  tds: string;
  net: string;
}
interface Run {
  id: string;
  entityId: string;
  month: string;
  status: 'draft' | 'pending' | 'approved' | 'posted' | 'paid';
  totals: Record<string, string | number>;
  lines: RunLine[];
  adjustments: {
    id: string;
    employeeId: string;
    code: string;
    name: string;
    amount: string;
    note: string;
  }[];
  withoutSalary: { id: string; code: string; name: string }[];
  voucherId: string | null;
  voucher: string | null;
  payment: string | null;
  approval: Approval | null;
}
const STATUS_TONE = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'accent',
  posted: 'accent',
  paid: 'success',
} as const;
const prevMonth = () => {
  const d = today();
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export function useComponents() {
  return useQuery({
    queryKey: ['pay-components'],
    queryFn: () => api.request<Component[]>('/api/tenant/payroll/components'),
  });
}

export function PayrollScreen() {
  const [tab, setTab] = useState<'Runs' | 'Year' | 'Rules' | 'Components'>('Runs');
  return (
    <Books title="Payroll">
      {(entityId) => (
        <>
          <div className="flex flex-wrap gap-1" role="tablist">
            {(['Runs', 'Year', 'Rules', 'Components'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-surface-2 font-medium' : 'text-fg-muted hover:bg-surface-2'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === 'Runs' && <Runs entityId={entityId} />}
          {tab === 'Year' && (
            <>
              <YearForm entityId={entityId} />
              <BonusCard entityId={entityId} />
            </>
          )}
          {tab === 'Rules' && <Rules />}
          {tab === 'Components' && <Components />}
        </>
      )}
    </Books>
  );
}

function Runs({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ['pay-runs', entityId],
    queryFn: () =>
      api.request<
        {
          id: string;
          month: string;
          status: Run['status'];
          employees: number;
          gross: string;
          net: string;
        }[]
      >(`/api/tenant/payroll/runs?entityId=${entityId}`),
  });
  const [month, setMonth] = useState(prevMonth());
  const [error, setError] = useState<string | null>(null);
  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/api/tenant/payroll/runs', { method: 'POST', body: { entityId, month } });
      void qc.invalidateQueries({ queryKey: ['pay-runs', entityId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Monthly runs">
      <form
        aria-label="New run"
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => void start(e)}
      >
        <Field label="Month">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </Field>
        <Button type="submit">Work the month</Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
      {runs.isPending ? (
        <Spinner />
      ) : runs.isError ? (
        <Alert tone="danger">{describeError(runs.error)}</Alert>
      ) : runs.data.length === 0 ? (
        <p className="text-sm text-fg-muted">No runs yet.</p>
      ) : (
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>Month</th>
              <th>Status</th>
              <th className="text-right">Staff</th>
              <th className="text-right">Gross</th>
              <th className="text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link
                    to="/payroll/runs/$runId"
                    params={{ runId: r.id }}
                    className="font-medium hover:underline"
                  >
                    {r.month}
                  </Link>
                </td>
                <td>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </td>
                <td className="text-right">{r.employees}</td>
                <td className="text-right">{rupees(r.gross)}</td>
                <td className="text-right">{rupees(r.net)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const RULE_KINDS = ['wages', 'pf', 'esi', 'pt', 'lwf', 'income_tax'];
function Rules() {
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ['pay-rules'],
    queryFn: () => api.request<Rule[]>('/api/tenant/payroll/rules'),
  });
  const [f, setF] = useState({
    kind: 'pf',
    stateCode: '',
    effectiveFrom: today(),
    data: '',
    note: '',
  });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['pay-rules'],
        await api.request('/api/tenant/payroll/rules', {
          method: 'POST',
          body: { ...f, stateCode: f.stateCode || null, data: JSON.parse(f.data) as unknown },
        }),
      );
    } catch (err) {
      setError(err instanceof SyntaxError ? 'The figures are not valid JSON.' : describeError(err));
    }
  };
  return (
    <Card title="Compliance rules">
      <p className="mb-3 text-sm text-fg-muted">
        Each rule applies from its date; a month is worked by the versions in force on its last day.
        A correction is a new version, never a change to an old one. These figures are to be
        confirmed by a payroll practitioner.
      </p>
      {rules.data && (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Rule</th>
              <th>State</th>
              <th>From</th>
              <th>Figures</th>
            </tr>
          </thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.kind}
                  {r.note && <div className="text-xs text-fg-muted">{r.note}</div>}
                </td>
                <td>{r.stateCode ?? '—'}</td>
                <td>{r.effectiveFrom}</td>
                <td className="max-w-md break-all font-mono text-[11px]">
                  {JSON.stringify(r.data)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New rule version"
        className="mt-4 grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => void add(e)}
      >
        <Field label="Rule">
          <Select
            value={f.kind}
            onChange={(e) => {
              const prior = rules.data?.find((r) => r.kind === e.target.value);
              setF({
                ...f,
                kind: e.target.value,
                data: prior ? JSON.stringify(prior.data, null, 1) : '',
              });
            }}
          >
            {RULE_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </Field>
        <Field label="State code (PT, LWF)">
          <Input
            value={f.stateCode}
            maxLength={2}
            onChange={(e) => setF({ ...f, stateCode: e.target.value })}
          />
        </Field>
        <Field label="From">
          <Input
            type="date"
            value={f.effectiveFrom}
            onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
          />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        <div className="sm:col-span-4">
          <Field label="Figures (JSON)">
            <textarea
              className="h-32 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs"
              value={f.data}
              onChange={(e) => setF({ ...f, data: e.target.value })}
              required
            />
          </Field>
        </div>
        <Button type="submit">Add the version</Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

function Components() {
  const qc = useQueryClient();
  const list = useComponents();
  const [f, setF] = useState({
    code: '',
    name: '',
    kind: 'earning',
    inWages: false,
    taxable: true,
    prorated: true,
  });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['pay-components'],
        await api.request('/api/tenant/payroll/components', { method: 'POST', body: f }),
      );
      setF({ ...f, code: '', name: '' });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Pay components">
      {list.data && (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Wages</th>
              <th>Taxable</th>
              <th>Cut for unpaid days</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{c.kind}</td>
                <td>{c.inWages ? 'yes' : ''}</td>
                <td>{c.taxable ? 'yes' : ''}</td>
                <td>{c.prorated ? 'yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New component"
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => void add(e)}
      >
        <Field label="Code">
          <Input
            value={f.code}
            maxLength={12}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            required
          />
        </Field>
        <Field label="Name">
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="earning">Earning</option>
            <option value="deduction">Deduction</option>
          </Select>
        </Field>
        {(['inWages', 'taxable', 'prorated'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1 pb-2 text-sm">
            <input
              type="checkbox"
              checked={f[k]}
              onChange={(e) => setF({ ...f, [k]: e.target.checked })}
            />
            {k === 'inWages' ? 'Wages' : k === 'taxable' ? 'Taxable' : 'Cut for unpaid days'}
          </label>
        ))}
        <Button type="submit">Add</Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

export function PayrollRunScreen({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const key = ['pay-run', runId];
  const run = useQuery({
    queryKey: key,
    queryFn: () => api.request<Run>(`/api/tenant/payroll/runs/${runId}`),
  });
  const components = useComponents();
  const chart = useChart({ ifAllowed: true });
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const [adj, setAdj] = useState({ employeeId: '', componentId: '', amount: '', note: '' });
  const [pay, setPay] = useState({ bankAccountId: '', date: today() });
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body: object = {}) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Run>(`/api/tenant/payroll/runs/${runId}${path}`, {
          method: 'POST',
          body,
        }),
      );
      void qc.invalidateQueries({ queryKey: ['pay-runs'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const removeAdj = async (id: string) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Run>(`/api/tenant/payroll/runs/${runId}/adjustments/${id}`, {
          method: 'DELETE',
        }),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  const file = async (path: string) => {
    setError(null);
    try {
      const f = await api.download(`/api/tenant/payroll/runs/${runId}/${path}`);
      saveFile(f.blob, f.fileName);
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (run.isPending) return <Spinner />;
  if (run.isError) return <Alert tone="danger">{describeError(run.error)}</Alert>;
  const r = run.data;
  const t = r.totals;
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Payroll, ${r.month}`}
        subtitle={
          <>
            <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
            {r.voucher && ` · posted ${r.voucher}`}
            {r.payment && ` · paid ${r.payment}`}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {r.status === 'draft' && (
              <>
                <Button type="button" variant="secondary" onClick={() => void act('/work')}>
                  Work again
                </Button>
                <Button type="button" onClick={() => void act('/submit')}>
                  Submit for approval
                </Button>
              </>
            )}
            {r.status === 'approved' && (
              <Button type="button" onClick={() => void act('/post')}>
                Post
              </Button>
            )}
            {(r.status === 'approved' || r.status === 'posted' || r.status === 'paid') && (
              <>
                <Button type="button" variant="secondary" onClick={() => void file('bank-file')}>
                  Bank file
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void file('ecr?format=txt')}
                >
                  PF ECR
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void file('esi?format=xlsx')}
                >
                  ESI file
                </Button>
              </>
            )}
          </div>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {(r.status === 'posted' || r.status === 'paid') && (
        <StatutoryDues runId={runId} banks={banks} />
      )}
      <Card title="Totals">
        <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="run-totals">
          {(
            [
              ['Gross', t.gross],
              ['Net pay', t.net],
              ['PF (employees)', t.pfEmployee],
              ['PF (employer, EDLI, admin)', Number(t.pfEmployer) + Number(t.pfCharges)],
              ['ESI', Number(t.esiEmployee) + Number(t.esiEmployer)],
              ['Professional tax', t.pt],
              ['TDS', t.tds],
              ['Other deductions', t.otherDeductions],
            ] as const
          ).map(([label, v]) => (
            <div key={label}>
              <dt className="text-xs text-fg-muted">{label}</dt>
              <dd className="font-medium">{rupees(String(v ?? 0))}</dd>
            </div>
          ))}
        </dl>
        {r.withoutSalary.length > 0 && (
          <Alert tone="warning">
            Without a salary, so not in the run:{' '}
            {r.withoutSalary.map((e) => `${e.code} ${e.name}`).join(', ')}.
          </Alert>
        )}
        {r.approval && <ApprovalSteps approval={r.approval} />}
      </Card>
      <Card title="Staff">
        <Table minWidth="56rem">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="text-right">Days</th>
              <th className="text-right">Gross</th>
              <th className="text-right">PF</th>
              <th className="text-right">ESI</th>
              <th className="text-right">PT</th>
              <th className="text-right">TDS</th>
              <th className="text-right">Other</th>
              <th className="text-right">Net</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.employeeId} data-testid={`run-${l.code}`}>
                <td>
                  {l.code} {l.name}
                </td>
                <td className="text-right">
                  {l.payableDays}/{l.days}
                </td>
                <td className="text-right">{rupees(l.gross)}</td>
                <td className="text-right">{rupees(String(l.pf.employee ?? 0))}</td>
                <td className="text-right">{rupees(l.esiEmployee)}</td>
                <td className="text-right">{rupees(l.pt)}</td>
                <td className="text-right">{rupees(l.tds)}</td>
                <td className="text-right">
                  {rupees(String(l.deductions.reduce((s, d) => s + d.amount, 0)))}
                </td>
                <td className="text-right font-medium">{rupees(l.net)}</td>
                <td>
                  <Link
                    to="/payroll/runs/$runId/payslips/$employeeId"
                    params={{ runId, employeeId: l.employeeId }}
                    className="text-sm hover:underline"
                  >
                    Payslip
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {r.status === 'draft' && (
        <Card title="Arrears and deductions this month">
          {r.adjustments.length > 0 && (
            <ul className="mb-3 text-sm">
              {r.adjustments.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  {r.lines.find((l) => l.employeeId === a.employeeId)?.code} · {a.name}{' '}
                  {rupees(a.amount)} {a.note}
                  <Button type="button" variant="ghost" onClick={() => void removeAdj(a.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            aria-label="Add to the run"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act('/adjustments', adj);
            }}
          >
            <Field label="Employee">
              <Select
                value={adj.employeeId}
                onChange={(e) => setAdj({ ...adj, employeeId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {r.lines.map((l) => (
                  <option key={l.employeeId} value={l.employeeId}>
                    {l.code} {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Component">
              <Select
                value={adj.componentId}
                onChange={(e) => setAdj({ ...adj, componentId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {(components.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount ₹">
              <Input
                inputMode="decimal"
                value={adj.amount}
                onChange={(e) => setAdj({ ...adj, amount: e.target.value })}
                required
              />
            </Field>
            <Field label="Note">
              <Input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
            </Field>
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </form>
        </Card>
      )}
      {r.status === 'posted' && (
        <Card title="Pay the net">
          <form
            aria-label="Pay"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act('/pay', pay);
            }}
          >
            <Field label="From the bank">
              <Select
                value={pay.bankAccountId}
                onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On">
              <Input
                type="date"
                value={pay.date}
                onChange={(e) => setPay({ ...pay, date: e.target.value })}
                required
              />
            </Field>
            <Button type="submit">Record the payment</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

interface Slip {
  month: string;
  company: string;
  code: string;
  name: string;
  designation: string | null;
  department: string;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  bankAccount: string | null;
  days: string;
  payableDays: string;
  earnings: Earning[];
  deductions: { name: string; amount: number }[];
  gross: string;
  pf: Pf;
  esiEmployee: string;
  pt: string;
  lwfEmployee: string;
  tds: string;
  net: string;
}

export function PayslipScreen({ runId, employeeId }: { runId: string; employeeId: string }) {
  const slip = useQuery({
    queryKey: ['payslip', runId, employeeId],
    queryFn: () => api.request<Slip>(`/api/tenant/payroll/runs/${runId}/payslips/${employeeId}`),
  });
  if (slip.isPending) return <Spinner />;
  if (slip.isError) return <Alert tone="danger">{describeError(slip.error)}</Alert>;
  const s = slip.data;
  const deductions = [
    ['Provident fund', s.pf.employee ?? 0],
    ['ESI', Number(s.esiEmployee)],
    ['Professional tax', Number(s.pt)],
    ['Labour welfare fund', Number(s.lwfEmployee)],
    ['Income tax (TDS)', Number(s.tds)],
    ...s.deductions.map((d) => [d.name, d.amount] as const),
  ].filter(([, v]) => Number(v) > 0) as [string, number][];
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex justify-end print:hidden">
        <Link
          to="/print/payslips/$runId/$employeeId"
          params={{ runId, employeeId }}
          className={printLink}
        >
          Print or save as PDF
        </Link>
      </div>
      <Card>
        <div className="mb-4 border-b border-line pb-3">
          <h1 className="text-lg font-semibold">{s.company}</h1>
          <p className="text-sm">Payslip for {s.month}</p>
        </div>
        <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {(
            [
              ['Employee', `${s.code} ${s.name}`],
              ['Designation', s.designation ?? '—'],
              ['Department', s.department || '—'],
              ['PAN', s.pan ?? '—'],
              ['UAN', s.uan ?? '—'],
              ['ESI number', s.esiNumber ?? '—'],
              ['Bank account', s.bankAccount ?? '—'],
              ['Days paid', `${s.payableDays} of ${s.days}`],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-fg-muted">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="grid gap-6 sm:grid-cols-2">
          <Table minWidth="16rem">
            <thead>
              <tr>
                <th>Earnings</th>
                <th className="text-right">₹</th>
              </tr>
            </thead>
            <tbody>
              {s.earnings.map((e) => (
                <tr key={`${e.code}-${e.name}`}>
                  <td>{e.name}</td>
                  <td className="text-right">{rupees(String(e.amount))}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td>Gross</td>
                <td className="text-right">{rupees(s.gross)}</td>
              </tr>
            </tbody>
          </Table>
          <Table minWidth="16rem">
            <thead>
              <tr>
                <th>Deductions</th>
                <th className="text-right">₹</th>
              </tr>
            </thead>
            <tbody>
              {deductions.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="text-right">{rupees(String(v))}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        <p className="mt-4 text-right text-base font-semibold" data-testid="payslip-net">
          Net pay {rupees(s.net)}
        </p>
      </Card>
    </div>
  );
}

/** An employee's salary history and a new salary from a date (on the employee's page, for payroll). */
export function SalaryCard({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const may = usePermission('payroll.run');
  const see = usePermission('payroll.view') || may;
  const key = ['salary', employeeId];
  const salaries = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<
        {
          id: string;
          from: string;
          pfMode: string;
          esi: boolean;
          regime: string;
          oldDeductions: string;
          lines: {
            componentId: string;
            code: string;
            name: string;
            amount: string | null;
            percentOfBasic: string | null;
          }[];
        }[]
      >(`/api/tenant/payroll/employees/${employeeId}/salary`),
    enabled: see,
  });
  const components = useComponents();
  const [f, setF] = useState({
    from: today(),
    pfMode: 'ceiling',
    esi: true,
    regime: 'new',
    oldDeductions: '0',
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!see) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request(`/api/tenant/payroll/employees/${employeeId}/salary`, {
          method: 'POST',
          body: {
            ...f,
            lines: Object.entries(amounts)
              .filter(([, v]) => v)
              .map(([componentId, amount]) => ({ componentId, amount })),
          },
        }),
      );
      setAmounts({});
    } catch (err) {
      setError(describeError(err));
    }
  };
  const earnings = (components.data ?? []).filter(
    (c) => c.kind === 'earning' && c.prorated && c.active,
  );
  return (
    <Card title="Salary">
      {salaries.data && salaries.data.length > 0 ? (
        <ul className="mb-3 space-y-1 text-sm">
          {salaries.data.map((s) => (
            <li key={s.id}>
              From {s.from}:{' '}
              {s.lines
                .map(
                  (l) =>
                    `${l.code} ${l.amount ? rupees(l.amount) : `${l.percentOfBasic}% of basic`}`,
                )
                .join(', ')}{' '}
              · PF {s.pfMode} · {s.regime} regime
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-fg-muted">No salary yet.</p>
      )}
      {may && (
        <form
          aria-label="New salary"
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => void save(e)}
        >
          <Field label="From">
            <Input
              type="date"
              value={f.from}
              onChange={(e) => setF({ ...f, from: e.target.value })}
              required
            />
          </Field>
          {earnings.map((c) => (
            <Field key={c.id} label={`${c.name} ₹ a month`}>
              <Input
                inputMode="decimal"
                value={amounts[c.id] ?? ''}
                onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="PF">
            <Select value={f.pfMode} onChange={(e) => setF({ ...f, pfMode: e.target.value })}>
              <option value="ceiling">On wages up to the ceiling</option>
              <option value="actual">On actual wages</option>
              <option value="none">Not a member</option>
            </Select>
          </Field>
          <Field label="Tax regime">
            <Select value={f.regime} onChange={(e) => setF({ ...f, regime: e.target.value })}>
              <option value="new">New</option>
              <option value="old">Old</option>
            </Select>
          </Field>
          {f.regime === 'old' && (
            <Field label="Declared deductions ₹ a year">
              <Input
                inputMode="decimal"
                value={f.oldDeductions}
                onChange={(e) => setF({ ...f, oldDeductions: e.target.value })}
              />
            </Field>
          )}
          <label className="flex items-center gap-1 pb-2 text-sm">
            <input
              type="checkbox"
              checked={f.esi}
              onChange={(e) => setF({ ...f, esi: e.target.checked })}
            />
            ESI when within its ceiling
          </label>
          <div className="flex items-end">
            <Button type="submit">Save the salary</Button>
          </div>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

/** The signed-in employee's payslips (on My attendance). */
export function MyPayslips() {
  const mine = useQuery({
    queryKey: ['my-payslips'],
    queryFn: () =>
      api.request<{ runId: string; month: string; net: string }[]>(
        '/api/tenant/payroll/payslips/mine',
      ),
  });
  if (!mine.data?.length) return null;
  return (
    <Card title="My payslips">
      <ul className="space-y-1 text-sm">
        {mine.data.map((p) => (
          <li key={p.runId}>
            <MyPayslipLink runId={p.runId} label={`${p.month} · ${rupees(p.net)}`} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MyPayslipLink({ runId, label }: { runId: string; label: string }) {
  const me = useQuery({
    queryKey: ['hr-me'],
    queryFn: () => api.request<{ employee: { id: string } | null }>('/api/tenant/hr/attendance/me'),
  });
  if (!me.data?.employee) return <span>{label}</span>;
  return (
    <Link
      to="/payroll/runs/$runId/payslips/$employeeId"
      params={{ runId, employeeId: me.data.employee.id }}
      className="hover:underline"
    >
      {label}
    </Link>
  );
}

function YearForm({ entityId }: { entityId: string }) {
  const thisYear = Number(today().slice(0, 4)) - (Number(today().slice(5, 7)) < 4 ? 1 : 0);
  const [year, setYear] = useState(thisYear);
  const y = useQuery({
    queryKey: ['pay-year', entityId, year],
    queryFn: () =>
      api.request<{
        financialYear: string;
        employees: {
          employeeId: string;
          code: string;
          name: string;
          pan: string | null;
          regime: string;
          grossSalary: string;
          standardDeduction: string;
          declaredDeductions: string;
          taxableIncome: string;
          tdsByQuarter: Record<string, string>;
          tds: string;
        }[];
      }>(`/api/tenant/payroll/year-form?entityId=${entityId}&year=${year}`),
  });
  return (
    <Card
      title={`Form 16 (Form 130) data${y.data ? `, ${y.data.financialYear}` : ''}`}
      actions={
        <Select
          aria-label="Financial year"
          value={String(year)}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[thisYear - 1, thisYear].map((v) => (
            <option key={v} value={v}>
              {v}-{String((v + 1) % 100).padStart(2, '0')}
            </option>
          ))}
        </Select>
      }
    >
      {y.isPending ? (
        <Spinner />
      ) : y.isError ? (
        <Alert tone="danger">{describeError(y.error)}</Alert>
      ) : y.data.employees.length === 0 ? (
        <p className="text-sm text-fg-muted">No approved runs in the year.</p>
      ) : (
        <Table minWidth="52rem">
          <thead>
            <tr>
              <th>Employee</th>
              <th>PAN</th>
              <th>Regime</th>
              <th className="text-right">Salary</th>
              <th className="text-right">Deductions</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">TDS Q1–Q4</th>
              <th className="text-right">TDS</th>
            </tr>
          </thead>
          <tbody>
            {y.data.employees.map((e) => (
              <tr key={e.employeeId}>
                <td>
                  <Link
                    to="/print/form-16/$entityId/$year/$employeeId"
                    params={{ entityId, year: String(year), employeeId: e.employeeId }}
                    target="_blank"
                    className="hover:underline"
                  >
                    {e.code} {e.name}
                  </Link>
                </td>
                <td>{e.pan ?? '—'}</td>
                <td>{e.regime}</td>
                <td className="text-right">{rupees(e.grossSalary)}</td>
                <td className="text-right">
                  {rupees(String(Number(e.standardDeduction) + Number(e.declaredDeductions)))}
                </td>
                <td className="text-right">{rupees(e.taxableIncome)}</td>
                <td className="text-right text-xs">
                  {Object.values(e.tdsByQuarter)
                    .map((v) => rupees(v))
                    .join(' · ')}
                </td>
                <td className="text-right font-medium">{rupees(e.tds)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface Settlement {
  lastDay: string;
  reason: string;
  wages: string;
  years: number;
  gratuity: string;
  leaveDays: string;
  encashment: string;
  noticeDays: string;
  noticeAmount: string;
  total: string;
  status: string;
  voucher: string | null;
}

/** A leaver's full and final settlement (on the employee's page, for payroll). */
export function SettlementCard({
  employeeId,
  leftOn,
}: {
  employeeId: string;
  leftOn: string | null;
}) {
  const qc = useQueryClient();
  const may = usePermission('payroll.run');
  const key = ['settlement', employeeId];
  const s = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Settlement | null>(`/api/tenant/payroll/employees/${employeeId}/settlement`),
    enabled: may && Boolean(leftOn),
  });
  const [f, setF] = useState({ reason: 'resigned', noticeDays: '0', leaveTypeCode: 'EL' });
  const [error, setError] = useState<string | null>(null);
  if (!may || !leftOn) return null;
  const act = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Settlement>(
          `/api/tenant/payroll/employees/${employeeId}/settlement${path}`,
          {
            method: 'POST',
            body,
          },
        ),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  const d = s.data;
  return (
    <Card title="Full and final">
      {d && (
        <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-4" data-testid="settlement">
          {(
            [
              ['Years counted', String(d.years)],
              ['Gratuity', rupees(d.gratuity)],
              [`Leave encashed (${d.leaveDays} days)`, rupees(d.encashment)],
              [`Notice (${d.noticeDays} days)`, rupees(d.noticeAmount)],
              ['Total', rupees(d.total)],
              ['Status', d.voucher ? `${d.status}, ${d.voucher}` : d.status],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-fg-muted">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {(!d || d.status === 'draft') && (
        <form
          aria-label="Settlement"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('', { ...f, leaveTypeCode: f.leaveTypeCode || null });
          }}
        >
          <Field label="Reason">
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
              <option value="resigned">Resigned</option>
              <option value="retired">Retired</option>
              <option value="terminated">Terminated</option>
              <option value="contract_ended">Contract ended</option>
              <option value="died">Died</option>
            </Select>
          </Field>
          <Field label="Notice days (negative if short)">
            <Input
              inputMode="decimal"
              value={f.noticeDays}
              onChange={(e) => setF({ ...f, noticeDays: e.target.value })}
            />
          </Field>
          <Field label="Leave encashed (type code)">
            <Input
              value={f.leaveTypeCode}
              onChange={(e) => setF({ ...f, leaveTypeCode: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Work it out
          </Button>
          {d && (
            <Button type="button" onClick={() => void act('/post', {})}>
              Post
            </Button>
          )}
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
