// Contract labour (docs/wave3-plan.md step 13): contractors and their licences, workers, minimum wages, the site's
// daily muster, monthly wage sheets checked against the minimum wage and verified as paid, the registers, and BOCW
// cess by project.
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
import type { Party, ProjectDetail, ProjectSummary } from '../../api/types';
import { today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { ComplianceCard } from './Compliance';

interface Contractor {
  partyId: string;
  name: string;
  licenceNo: string;
  licenceWorkers: number | null;
  licenceValidTo: string | null;
  bocwRegistration: string;
  workers: number;
  overLicence: boolean;
  licence: { daysLeft: number | null; lapsed: boolean; nearing: boolean };
}
interface Worker {
  id: string;
  name: string;
  trade: string;
  skill: string;
  dailyWage: string;
  joinedOn: string;
  leftOn: string | null;
  rowVersion: number;
}
interface SheetLine {
  workerId: string;
  name: string;
  skill: string;
  rate: number;
  days: number;
  overtimeHours: number;
  wages: number;
  overtime: number;
  gross: number;
  minimum: number | null;
  shortfall: number;
}
interface Sheet {
  id: string;
  contractor: string;
  site: string;
  project: string;
  month: string;
  status: 'draft' | 'passed' | 'verified';
  lines: SheetLine[];
  total: string;
  shortfall: string;
  paidOn: string | null;
  paidReference: string | null;
}
const SKILLS = ['unskilled', 'semi_skilled', 'skilled', 'highly_skilled'];
const skillLabel = (s: string) => s.replace('_', '-');

function useProjects() {
  return useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
}
function useSites(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
    enabled: Boolean(projectId),
    select: (p) => p.sites.filter((s) => s.active),
  });
}
function useContractors() {
  return useQuery({
    queryKey: ['labour-contractors'],
    queryFn: () => api.request<Contractor[]>('/api/tenant/labour/contractors'),
  });
}

export function LabourScreen() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Contract labour"
        subtitle="Contractors, their workers, wage sheets, minimum wages and cess."
      />
      <Contractors open={open} onOpen={setOpen} />
      {open && <ContractorCard key={open} partyId={open} />}
      {open && <ComplianceCard key={`c-${open}`} partyId={open} />}
      <MinWages />
      <Cess />
    </div>
  );
}

function Contractors({ open, onOpen }: { open: string | null; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const list = useContractors();
  const parties = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=vendor'),
  });
  const [f, setF] = useState({
    partyId: '',
    licenceNo: '',
    licenceWorkers: '',
    licenceValidTo: '',
    bocwRegistration: '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['labour-contractors'],
        await api.request(`/api/tenant/labour/contractors/${f.partyId}`, {
          method: 'PUT',
          body: {
            licenceNo: f.licenceNo,
            licenceWorkers: f.licenceWorkers ? Number(f.licenceWorkers) : null,
            licenceValidTo: f.licenceValidTo || null,
            bocwRegistration: f.bocwRegistration,
          },
        }),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Contractors">
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <p className="mb-3 text-sm text-fg-muted">
          No labour contractors yet: pick a supplier below.
        </p>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Contractor</th>
              <th>Licence</th>
              <th>Valid to</th>
              <th className="text-right">Workers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.partyId} aria-selected={open === c.partyId}>
                <td>{c.name}</td>
                <td>
                  {c.licenceNo || '—'}
                  {c.licenceWorkers && (
                    <span className="text-fg-muted"> (up to {c.licenceWorkers})</span>
                  )}
                </td>
                <td>
                  {c.licenceValidTo ?? '—'}{' '}
                  {c.licence.lapsed && <Badge tone="danger">lapsed</Badge>}
                  {c.licence.nearing && (
                    <Badge tone="warning">{c.licence.daysLeft} days left</Badge>
                  )}
                </td>
                <td className="text-right">
                  {c.workers} {c.overLicence && <Badge tone="danger">over the licence</Badge>}
                </td>
                <td>
                  <Button type="button" variant="ghost" onClick={() => onOpen(c.partyId)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="Contractor"
        className="mt-3 grid gap-3 sm:grid-cols-5"
        onSubmit={(e) => void save(e)}
      >
        <Field label="Supplier">
          <Select
            value={f.partyId}
            onChange={(e) => setF({ ...f, partyId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(parties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="CLRA licence">
          <Input value={f.licenceNo} onChange={(e) => setF({ ...f, licenceNo: e.target.value })} />
        </Field>
        <Field label="Workers allowed">
          <Input
            inputMode="numeric"
            value={f.licenceWorkers}
            onChange={(e) => setF({ ...f, licenceWorkers: e.target.value })}
          />
        </Field>
        <Field label="Valid to">
          <Input
            type="date"
            value={f.licenceValidTo}
            onChange={(e) => setF({ ...f, licenceValidTo: e.target.value })}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Save the contractor</Button>
        </div>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

function ContractorCard({ partyId }: { partyId: string }) {
  const qc = useQueryClient();
  const workers = useQuery({
    queryKey: ['labour-workers', partyId],
    queryFn: () => api.request<Worker[]>(`/api/tenant/labour/contractors/${partyId}/workers`),
  });
  const sheets = useQuery({
    queryKey: ['labour-sheets', partyId],
    queryFn: () =>
      api.request<
        {
          id: string;
          month: string;
          site: string;
          project: string;
          status: string;
          total: string;
          shortfall: string;
        }[]
      >(`/api/tenant/labour/contractors/${partyId}/wage-sheets`),
  });
  const projects = useProjects();
  const [w, setW] = useState({
    name: '',
    trade: '',
    skill: 'unskilled',
    dailyWage: '',
    joinedOn: today(),
  });
  const [s, setS] = useState({ projectId: '', siteId: '', month: today().slice(0, 7) });
  const sites = useSites(s.projectId);
  const [error, setError] = useState<string | null>(null);
  const addWorker = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['labour-workers', partyId],
        await api.request(`/api/tenant/labour/contractors/${partyId}/workers`, {
          method: 'POST',
          body: w,
        }),
      );
      setW({ ...w, name: '' });
      void qc.invalidateQueries({ queryKey: ['labour-contractors'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const newSheet = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/api/tenant/labour/wage-sheets', {
        method: 'POST',
        body: { partyId, siteId: s.siteId, month: s.month },
      });
      void qc.invalidateQueries({ queryKey: ['labour-sheets', partyId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Workers and wage sheets">
      {error && <Alert tone="danger">{error}</Alert>}
      {workers.data && workers.data.length > 0 && (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Trade</th>
              <th>Skill</th>
              <th className="text-right">A day</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {workers.data.map((x) => (
              <tr key={x.id}>
                <td>
                  {x.name} {x.leftOn && <Badge>left</Badge>}
                </td>
                <td>{x.trade}</td>
                <td>{skillLabel(x.skill)}</td>
                <td className="text-right">{rupees(x.dailyWage)}</td>
                <td>{x.joinedOn}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New worker"
        className="mt-3 grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => void addWorker(e)}
      >
        <Field label="Name">
          <Input
            value={w.name}
            onChange={(e) => setW({ ...w, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Trade">
          <Input
            value={w.trade}
            onChange={(e) => setW({ ...w, trade: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Skill">
          <Select value={w.skill} onChange={(e) => setW({ ...w, skill: e.target.value })}>
            {SKILLS.map((k) => (
              <option key={k} value={k}>
                {skillLabel(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Daily wage ₹">
          <Input
            inputMode="decimal"
            value={w.dailyWage}
            onChange={(e) => setW({ ...w, dailyWage: e.target.value })}
            required
          />
        </Field>
        <Field label="Joined">
          <Input
            type="date"
            value={w.joinedOn}
            onChange={(e) => setW({ ...w, joinedOn: e.target.value })}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Add worker
          </Button>
        </div>
      </form>
      <h3 className="mt-5 mb-2 text-sm font-semibold">Wage sheets</h3>
      {sheets.data && sheets.data.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {sheets.data.map((x) => (
            <li key={x.id}>
              <Link
                to="/labour/wage-sheets/$sheetId"
                params={{ sheetId: x.id }}
                className="hover:underline"
              >
                {x.month} · {x.project}, {x.site}
              </Link>{' '}
              · {rupees(x.total)}{' '}
              <Badge
                tone={
                  x.status === 'verified' ? 'success' : x.status === 'passed' ? 'accent' : 'neutral'
                }
              >
                {x.status}
              </Badge>
              {Number(x.shortfall) > 0 && (
                <Badge tone="danger">below minimum by {rupees(x.shortfall)}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="New wage sheet"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => void newSheet(e)}
      >
        <Field label="Project">
          <Select
            value={s.projectId}
            onChange={(e) => setS({ ...s, projectId: e.target.value, siteId: '' })}
            required
          >
            <option value="">Choose…</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Site">
          <Select
            value={s.siteId}
            onChange={(e) => setS({ ...s, siteId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(sites.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Month">
          <Input
            type="month"
            value={s.month}
            onChange={(e) => setS({ ...s, month: e.target.value })}
            required
          />
        </Field>
        <Button type="submit">Work the wage sheet</Button>
      </form>
    </Card>
  );
}

function MinWages() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['min-wages'],
    queryFn: () =>
      api.request<
        {
          id: string;
          stateCode: string;
          skill: string;
          zone: string;
          effectiveFrom: string;
          daily: string;
          note: string;
        }[]
      >('/api/tenant/labour/min-wages'),
  });
  const [f, setF] = useState({
    stateCode: '27',
    skill: 'unskilled',
    zone: '',
    effectiveFrom: today(),
    daily: '',
    note: '',
  });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['min-wages'],
        await api.request('/api/tenant/labour/min-wages', { method: 'POST', body: f }),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Minimum wages">
      <p className="mb-3 text-sm text-fg-muted">
        From your state&apos;s notification (rates change twice a year). None is filled in for you.
        A wage sheet uses the highest zone&apos;s rate in force on the month&apos;s last day.
      </p>
      {list.data && list.data.length > 0 && (
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>State</th>
              <th>Skill</th>
              <th>Zone</th>
              <th>From</th>
              <th className="text-right">A day</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((m) => (
              <tr key={m.id}>
                <td>{m.stateCode}</td>
                <td>{skillLabel(m.skill)}</td>
                <td>{m.zone || '—'}</td>
                <td>{m.effectiveFrom}</td>
                <td className="text-right">{rupees(m.daily)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New minimum wage"
        className="mt-3 grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => void add(e)}
      >
        <Field label="State code">
          <Input
            value={f.stateCode}
            maxLength={2}
            onChange={(e) => setF({ ...f, stateCode: e.target.value })}
            required
          />
        </Field>
        <Field label="Skill">
          <Select value={f.skill} onChange={(e) => setF({ ...f, skill: e.target.value })}>
            {SKILLS.map((k) => (
              <option key={k} value={k}>
                {skillLabel(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Zone">
          <Input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} />
        </Field>
        <Field label="From">
          <Input
            type="date"
            value={f.effectiveFrom}
            onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
            required
          />
        </Field>
        <Field label="₹ a day">
          <Input
            inputMode="decimal"
            value={f.daily}
            onChange={(e) => setF({ ...f, daily: e.target.value })}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Add
          </Button>
        </div>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

function Cess() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const cess = useQuery({
    queryKey: ['cess', projectId],
    queryFn: () =>
      api.request<{
        cost: string;
        due: string;
        deductedFromSubcontractors: string;
        paid: string;
        balance: string;
        payments: {
          id: string;
          paidOn: string;
          amount: string;
          reference: string;
          voucher: string;
        }[];
      }>(`/api/tenant/labour/projects/${projectId}/cess`),
    enabled: Boolean(projectId),
  });
  const chart = useChart({ ifAllowed: true });
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const [f, setF] = useState({ paidOn: today(), amount: '', reference: '', bankAccountId: '' });
  const [error, setError] = useState<string | null>(null);
  const pay = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['cess', projectId],
        await api.request(`/api/tenant/labour/projects/${projectId}/cess`, {
          method: 'POST',
          body: f,
        }),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="BOCW cess"
      actions={
        <Select
          aria-label="Project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Choose a project…</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.number} {p.name}
            </option>
          ))}
        </Select>
      }
    >
      {cess.data && (
        <dl className="mb-3 grid gap-3 text-sm sm:grid-cols-5" data-testid="cess">
          {(
            [
              ['Cost of construction', cess.data.cost],
              ['Cess due (1%)', cess.data.due],
              ['Deducted from subcontractors', cess.data.deductedFromSubcontractors],
              ['Paid', cess.data.paid],
              ['Balance', cess.data.balance],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-fg-muted">{k}</dt>
              <dd className="font-medium">{rupees(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {projectId && (
        <form
          aria-label="Pay cess"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => void pay(e)}
        >
          <Field label="Paid on">
            <Input
              type="date"
              value={f.paidOn}
              onChange={(e) => setF({ ...f, paidOn: e.target.value })}
              required
            />
          </Field>
          <Field label="Amount ₹">
            <Input
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
              required
            />
          </Field>
          <Field label="Challan">
            <Input
              value={f.reference}
              onChange={(e) => setF({ ...f, reference: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="From the bank">
            <Select
              value={f.bankAccountId}
              onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}
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
          <Button type="submit">Record the payment</Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

export function WageSheetScreen({ sheetId }: { sheetId: string }) {
  const qc = useQueryClient();
  const key = ['wage-sheet', sheetId];
  const s = useQuery({
    queryKey: key,
    queryFn: () => api.request<Sheet>(`/api/tenant/labour/wage-sheets/${sheetId}`),
  });
  const [paid, setPaid] = useState({ paidOn: today(), reference: '', mode: 'bank' });
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body: object = {}) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Sheet>(`/api/tenant/labour/wage-sheets/${sheetId}/${path}`, {
          method: 'POST',
          body,
        }),
      );
      void qc.invalidateQueries({ queryKey: ['labour-sheets'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const registers = async () => {
    setError(null);
    try {
      const f = await api.download(`/api/tenant/labour/wage-sheets/${sheetId}/registers`);
      saveFile(f.blob, f.fileName);
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (s.isPending) return <Spinner />;
  if (s.isError) return <Alert tone="danger">{describeError(s.error)}</Alert>;
  const d = s.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title={`Wage sheet, ${d.month}`}
        subtitle={`${d.contractor} · ${d.project}, ${d.site}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {d.status === 'draft' && (
              <>
                <Button type="button" variant="secondary" onClick={() => void act('work')}>
                  Work again
                </Button>
                <Button type="button" onClick={() => void act('pass')}>
                  Pass
                </Button>
              </>
            )}
            <Button type="button" variant="secondary" onClick={() => void registers()}>
              Registers
            </Button>
          </div>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <p className="mb-3 text-sm">
          <Badge
            tone={
              d.status === 'verified' ? 'success' : d.status === 'passed' ? 'accent' : 'neutral'
            }
          >
            {d.status}
          </Badge>{' '}
          Total {rupees(d.total)}
          {Number(d.shortfall) > 0 && (
            <>
              {' '}
              <Badge tone="danger">below the minimum wage by {rupees(d.shortfall)}</Badge>
            </>
          )}
          {d.paidOn && ` · paid ${d.paidOn}, ${d.paidReference}`}
        </p>
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Skill</th>
              <th className="text-right">Days</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Wages</th>
              <th className="text-right">Overtime</th>
              <th className="text-right">Gross</th>
              <th className="text-right">Minimum</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.workerId} data-testid={`sheet-${l.name}`}>
                <td>{l.name}</td>
                <td>{skillLabel(l.skill)}</td>
                <td className="text-right">{l.days}</td>
                <td className="text-right">{rupees(String(l.rate))}</td>
                <td className="text-right">{rupees(String(l.wages))}</td>
                <td className="text-right">
                  {l.overtimeHours > 0
                    ? `${l.overtimeHours} h · ${rupees(String(l.overtime))}`
                    : '—'}
                </td>
                <td className="text-right font-medium">{rupees(String(l.gross))}</td>
                <td className="text-right">
                  {l.minimum === null ? (
                    <span className="text-fg-muted">none on record</span>
                  ) : (
                    <>
                      {rupees(String(l.minimum))}
                      {l.shortfall > 0 && (
                        <Badge tone="danger">short {rupees(String(l.shortfall))}</Badge>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {d.status === 'passed' && (
        <Card title="The contractor's proof of payment">
          <form
            aria-label="Verify"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act('verify', paid);
            }}
          >
            <Field label="Paid on">
              <Input
                type="date"
                value={paid.paidOn}
                onChange={(e) => setPaid({ ...paid, paidOn: e.target.value })}
                required
              />
            </Field>
            <Field label="Reference">
              <Input
                value={paid.reference}
                onChange={(e) => setPaid({ ...paid, reference: e.target.value })}
                required
                minLength={2}
              />
            </Field>
            <Field label="Mode">
              <Select
                value={paid.mode}
                onChange={(e) => setPaid({ ...paid, mode: e.target.value })}
              >
                <option value="bank">Bank</option>
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
              </Select>
            </Field>
            <Button type="submit">Verified as paid</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

export function MusterScreen() {
  const qc = useQueryClient();
  const projects = useProjects();
  const contractors = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=vendor'),
  });
  const [f, setF] = useState({ projectId: '', siteId: '', partyId: '', day: today() });
  const sites = useSites(f.projectId);
  const key = ['muster', f.siteId, f.partyId, f.day];
  const m = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{
        rows: {
          workerId: string;
          name: string;
          trade: string;
          status: string | null;
          overtimeHours: string | null;
          elsewhere: boolean;
        }[];
      }>(`/api/tenant/labour/sites/${f.siteId}/muster?date=${f.day}&partyId=${f.partyId}`),
    enabled: Boolean(f.siteId && f.partyId),
  });
  const [edits, setEdits] = useState<
    Record<string, { status?: string | null; overtimeHours?: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const marks = Object.entries(edits).map(([workerId, x]) => {
        const r = m.data!.rows.find((y) => y.workerId === workerId)!;
        return {
          workerId,
          status: x.status !== undefined ? x.status : r.status,
          overtimeHours: x.overtimeHours ?? r.overtimeHours ?? '0',
        };
      });
      qc.setQueryData(
        key,
        await api.request(`/api/tenant/labour/sites/${f.siteId}/muster`, {
          method: 'POST',
          body: { date: f.day, partyId: f.partyId, marks },
        }),
      );
      setEdits({});
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Labour muster" subtitle="A contractor's workers at a site, day by day." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Project">
            <Select
              value={f.projectId}
              onChange={(e) => setF({ ...f, projectId: e.target.value, siteId: '' })}
            >
              <option value="">Choose…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Site">
            <Select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
              <option value="">Choose…</option>
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contractor">
            <Select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}>
              <option value="">Choose…</option>
              {(contractors.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Day">
            <Input
              type="date"
              value={f.day}
              max={today()}
              onChange={(e) => {
                setF({ ...f, day: e.target.value });
                setEdits({});
              }}
            />
          </Field>
        </div>
      </Card>
      {f.siteId && f.partyId && (
        <Card title="Muster">
          {m.isPending ? (
            <Spinner />
          ) : m.isError ? (
            <Alert tone="danger">{describeError(m.error)}</Alert>
          ) : m.data.rows.length === 0 ? (
            <p className="text-sm text-fg-muted">This contractor has no workers on that day.</p>
          ) : (
            <form aria-label="Muster" onSubmit={(e) => void save(e)}>
              <Table minWidth="32rem">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Trade</th>
                    <th>Mark</th>
                    <th>Overtime hours</th>
                  </tr>
                </thead>
                <tbody>
                  {m.data.rows.map((r) => {
                    const x = {
                      status: r.status,
                      overtimeHours: r.overtimeHours ?? '',
                      ...edits[r.workerId],
                    };
                    const set = (patch: { status?: string | null; overtimeHours?: string }) =>
                      setEdits({ ...edits, [r.workerId]: { ...edits[r.workerId], ...patch } });
                    return (
                      <tr key={r.workerId} aria-label={r.name}>
                        <td>
                          {r.name} {r.elsewhere && <Badge tone="warning">on another site</Badge>}
                        </td>
                        <td>{r.trade}</td>
                        <td>
                          <Select
                            aria-label="Mark"
                            value={x.status ?? ''}
                            onChange={(e) => set({ status: e.target.value || null })}
                          >
                            <option value="">—</option>
                            <option value="present">Present</option>
                            <option value="half_day">Half day</option>
                            <option value="absent">Absent</option>
                          </Select>
                        </td>
                        <td>
                          <Input
                            aria-label="Overtime"
                            inputMode="decimal"
                            value={x.overtimeHours ?? ''}
                            onChange={(e) => set({ overtimeHours: e.target.value })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="mt-3 flex items-center gap-3">
                <Button type="submit" disabled={Object.keys(edits).length === 0}>
                  Save the muster
                </Button>
                {saved && <span className="text-sm text-fg-muted">Saved.</span>}
              </div>
              {error && <Alert tone="danger">{error}</Alert>}
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
