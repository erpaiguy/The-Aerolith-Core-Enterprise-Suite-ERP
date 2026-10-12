// Equipment and fleet (docs/wave3-plan.md step 10): the register, a machine's allocation, log sheets and maintenance,
// fuel against the norm, and the month's costing (own machines charged to projects, hire bills from the logs).
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { Party, ProjectDetail, ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from './Vouchers';

interface Row {
  id: string;
  code: string;
  name: string;
  category: string;
  ownership: 'own' | 'hired';
  supplier: string | null;
  place: {
    from: string;
    project: string | null;
    projectName: string | null;
    site: string | null;
  } | null;
}
interface Machine {
  id: string;
  code: string;
  name: string;
  ownership: 'own' | 'hired';
  meter: 'hours' | 'km';
  internalRate: string | null;
  supplier: { id: string; name: string } | null;
  hireBasis: string | null;
  hireRate: string | null;
  minHours: string;
  fuelNorm: string | null;
  allocations: {
    from: string;
    project: string | null;
    projectName: string | null;
    site: string | null;
  }[];
  maintenance: {
    reading: string | null;
    plans: {
      id: string;
      name: string;
      dueAtReading: string | null;
      dueOn: string | null;
      due: boolean;
    }[];
    records: { kind: string; doneOn: string; description: string; cost: string }[];
  };
  mayPost: boolean;
}
const monthOf = (d: string) => d.slice(0, 7);
const prevMonth = () => {
  const d = today();
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export function EquipmentScreen() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Books title="Equipment">
      {(entityId) => (
        <>
          <Register entityId={entityId} open={open} onOpen={setOpen} />
          {open && <MachineCard key={open} id={open} />}
          <Costing entityId={entityId} />
          <Fuel entityId={entityId} />
        </>
      )}
    </Books>
  );
}

function useProjects() {
  return useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
}

function Register({
  entityId,
  open,
  onOpen,
}: {
  entityId: string;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const key = ['equipment', entityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.request<Row[]>(`/api/tenant/equipment?entityId=${entityId}`),
  });
  const parties = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=vendor'),
  });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({
    code: '',
    name: '',
    category: 'excavator',
    meter: 'hours',
    ownership: 'own',
    internalRate: '',
    partyId: '',
    hireBasis: 'hour',
    hireRate: '',
    minHours: '',
    fuelNorm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const own = f.ownership === 'own';
      await api.request('/api/tenant/equipment', {
        method: 'POST',
        body: {
          entityId,
          code: f.code,
          name: f.name,
          category: f.category,
          meter: f.meter,
          ownership: f.ownership,
          internalRate: own ? f.internalRate : null,
          partyId: own ? null : f.partyId || null,
          hireBasis: own ? null : f.hireBasis,
          hireRate: own ? null : f.hireRate,
          minHours: own ? '0' : f.minHours || '0',
          fuelNorm: f.fuelNorm,
        },
      });
      setAdding(false);
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="Register"
      actions={
        mayPost &&
        !adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            Add a machine
          </Button>
        )
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {adding && (
        <form
          aria-label="New machine"
          className="mb-4 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => void add(e)}
        >
          <Field label="Code">
            <Input value={f.code} onChange={set('code')} required maxLength={30} />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={set('name')} required minLength={2} />
          </Field>
          <Field label="Category">
            <Select value={f.category} onChange={set('category')}>
              {['excavator', 'crane', 'mixer', 'vehicle', 'pump', 'other'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Meter">
            <Select value={f.meter} onChange={set('meter')}>
              <option value="hours">Hours</option>
              <option value="km">Kilometres</option>
            </Select>
          </Field>
          <Field label="Ownership">
            <Select value={f.ownership} onChange={set('ownership')}>
              <option value="own">Own</option>
              <option value="hired">Hired</option>
            </Select>
          </Field>
          {f.ownership === 'own' ? (
            <Field label="Internal rate ₹ an hour">
              <Input value={f.internalRate} onChange={set('internalRate')} />
            </Field>
          ) : (
            <>
              <Field label="Supplier">
                <Select value={f.partyId} onChange={set('partyId')} required>
                  <option value="">Who hires it out?</option>
                  {(parties.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hired by the">
                <Select value={f.hireBasis} onChange={set('hireBasis')}>
                  <option value="hour">Hour</option>
                  <option value="day">Day</option>
                  <option value="month">Month</option>
                </Select>
              </Field>
              <Field label="Rate ₹">
                <Input value={f.hireRate} onChange={set('hireRate')} required />
              </Field>
              {f.hireBasis === 'hour' && (
                <Field label="Monthly minimum hours">
                  <Input value={f.minHours} onChange={set('minHours')} />
                </Field>
              )}
            </>
          )}
          <Field label="Fuel norm (litres an hour)">
            <Input value={f.fuelNorm} onChange={set('fuelNorm')} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Add</Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-sm text-fg-muted">No machines registered.</p>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Own or hired</th>
              <th>Now at</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Equipment">
            {list.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="font-mono text-xs text-fg-muted">{r.code}</span> {r.name}
                </td>
                <td>{r.ownership === 'own' ? 'Own' : `Hired from ${r.supplier}`}</td>
                <td>
                  {r.place?.project
                    ? `${r.place.project} ${r.place.projectName}, ${r.place.site ?? ''}`
                    : 'Yard'}
                </td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onOpen(open === r.id ? null : r.id)}
                  >
                    {open === r.id ? 'Close' : 'Open'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function MachineCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const key = ['machine', id];
  const m = useQuery({
    queryKey: key,
    queryFn: () => api.request<Machine>(`/api/tenant/equipment/${id}`),
  });
  const projects = useProjects();
  const [alloc, setAlloc] = useState({ date: today(), projectId: '', siteId: '' });
  const project = useQuery({
    queryKey: ['project', alloc.projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${alloc.projectId}`),
    enabled: !!alloc.projectId,
  });
  const [log, setLog] = useState({
    date: today(),
    startReading: '',
    endReading: '',
    worked: '',
    idleHours: '',
    idleReason: '',
    breakdownHours: '',
    operator: '',
  });
  const [plan, setPlan] = useState({ name: '', everyHours: '', everyDays: '' });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const logs = useQuery({
    queryKey: ['machine-logs', id],
    queryFn: () =>
      api.request<
        {
          date: string;
          project: string;
          worked: string;
          idleHours: string;
          idleReason: string;
          breakdownHours: string;
        }[]
      >(`/api/tenant/equipment/${id}/logs?from=${monthOf(today())}-01&to=${today()}`),
  });
  const call = async (path: string, body: object, done: string) => {
    setError(null);
    setNote(null);
    try {
      await api.request(`/api/tenant/equipment/${id}/${path}`, { method: 'POST', body });
      setNote(done);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['machine-logs', id] });
      void qc.invalidateQueries({ queryKey: ['equipment'] });
      // The month's costing and fuel follow the log sheets.
      void qc.invalidateQueries({ queryKey: ['equipment-costing'] });
      void qc.invalidateQueries({ queryKey: ['fuel'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (m.isPending) return <Spinner />;
  if (m.isError) return <Alert tone="danger">{describeError(m.error)}</Alert>;
  const d = m.data;
  const blank = (v: string) => (v === '' ? null : v);
  return (
    <Card title={`${d.code} ${d.name}`}>
      {error && <Alert tone="danger">{error}</Alert>}
      {note && <p className="text-sm text-success">{note}</p>}
      <p className="text-sm text-fg-muted">
        {d.ownership === 'own'
          ? `Own; charged at ${d.internalRate ? rupees(d.internalRate) : '-'} an ${d.meter === 'km' ? 'km' : 'hour'}.`
          : `Hired from ${d.supplier?.name} at ${rupees(d.hireRate ?? '0')} a ${d.hireBasis}${Number(d.minHours) ? `, at least ${Number(d.minHours)} hours a month` : ''}.`}
        {d.maintenance.reading && ` Meter at ${Number(d.maintenance.reading)}.`}
      </p>
      <h3 className="mt-4 text-sm font-semibold">Where it has been</h3>
      <ul className="text-sm" aria-label="Allocations">
        {d.allocations.map((a) => (
          <li key={a.from}>
            From {shortDate(a.from)}:{' '}
            {a.project ? `${a.project} ${a.projectName}, ${a.site ?? ''}` : 'the yard'}
          </li>
        ))}
      </ul>
      {d.mayPost && (
        <form
          aria-label="Allocate"
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              'allocate',
              {
                date: alloc.date,
                projectId: alloc.projectId || null,
                siteId: alloc.siteId || null,
              },
              'Moved.',
            );
          }}
        >
          <Field label="From">
            <Input
              type="date"
              className="w-40"
              value={alloc.date}
              onChange={(e) => setAlloc({ ...alloc, date: e.target.value })}
            />
          </Field>
          <Field label="Project">
            <Select
              value={alloc.projectId}
              onChange={(e) => setAlloc({ ...alloc, projectId: e.target.value, siteId: '' })}
            >
              <option value="">The yard</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Site">
            <Select
              value={alloc.siteId}
              onChange={(e) => setAlloc({ ...alloc, siteId: e.target.value })}
            >
              <option value="">-</option>
              {(project.data?.sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary">
            Allocate
          </Button>
        </form>
      )}
      <h3 className="mt-4 text-sm font-semibold">Log sheets this month</h3>
      <form
        aria-label="Log sheet"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call(
            'logs',
            {
              date: log.date,
              startReading: blank(log.startReading),
              endReading: blank(log.endReading),
              worked: blank(log.worked),
              idleHours: log.idleHours || '0',
              idleReason: log.idleReason,
              breakdownHours: log.breakdownHours || '0',
              operator: log.operator,
            },
            'Log sheet saved.',
          );
        }}
      >
        <Field label="Date">
          <Input
            type="date"
            className="w-40"
            value={log.date}
            onChange={(e) => setLog({ ...log, date: e.target.value })}
          />
        </Field>
        <Field label="Opening reading">
          <Input
            className="w-24"
            value={log.startReading}
            onChange={(e) => setLog({ ...log, startReading: e.target.value })}
          />
        </Field>
        <Field label="Closing reading">
          <Input
            className="w-24"
            value={log.endReading}
            onChange={(e) => setLog({ ...log, endReading: e.target.value })}
          />
        </Field>
        <Field label="Or hours worked">
          <Input
            className="w-20"
            value={log.worked}
            onChange={(e) => setLog({ ...log, worked: e.target.value })}
          />
        </Field>
        <Field label="Idle hours">
          <Input
            className="w-20"
            value={log.idleHours}
            onChange={(e) => setLog({ ...log, idleHours: e.target.value })}
          />
        </Field>
        <Field label="Why idle">
          <Input
            value={log.idleReason}
            onChange={(e) => setLog({ ...log, idleReason: e.target.value })}
          />
        </Field>
        <Field label="Breakdown hours">
          <Input
            className="w-20"
            value={log.breakdownHours}
            onChange={(e) => setLog({ ...log, breakdownHours: e.target.value })}
          />
        </Field>
        <Field label="Operator">
          <Input
            value={log.operator}
            onChange={(e) => setLog({ ...log, operator: e.target.value })}
          />
        </Field>
        <Button type="submit">Save the log</Button>
      </form>
      {(logs.data?.length ?? 0) > 0 && (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Date</th>
              <th>Project</th>
              <th className="text-right">Worked</th>
              <th className="text-right">Idle</th>
              <th className="text-right">Breakdown</th>
            </tr>
          </thead>
          <tbody aria-label="Log sheets">
            {logs.data!.map((l) => (
              <tr key={l.date}>
                <td>{shortDate(l.date)}</td>
                <td>{l.project}</td>
                <td className="text-right tabular-nums">{Number(l.worked)}</td>
                <td className="text-right tabular-nums">
                  {Number(l.idleHours) ? `${Number(l.idleHours)} (${l.idleReason})` : '-'}
                </td>
                <td className="text-right tabular-nums">{Number(l.breakdownHours) || '-'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h3 className="mt-4 text-sm font-semibold">Maintenance</h3>
      <ul className="space-y-1 text-sm" aria-label="Maintenance plans">
        {d.maintenance.plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            {p.name}: due {p.dueAtReading ? `at ${Number(p.dueAtReading)}` : ''}
            {p.dueOn ? ` on ${shortDate(p.dueOn)}` : ''}{' '}
            {p.due && <Badge tone="warning">Due</Badge>}
            {d.mayPost && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  const what = window.prompt(`What was done for "${p.name}"?`);
                  if (what && what.trim().length >= 2)
                    void call(
                      'maintenance-records',
                      {
                        planId: p.id,
                        kind: 'service',
                        doneOn: today(),
                        reading: d.maintenance.reading,
                        description: what.trim(),
                      },
                      'Service recorded.',
                    );
                }}
              >
                Record it done
              </Button>
            )}
          </li>
        ))}
      </ul>
      {d.mayPost && (
        <form
          aria-label="Maintenance plan"
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              'maintenance-plans',
              {
                name: plan.name,
                everyHours: blank(plan.everyHours),
                everyDays: plan.everyDays ? Number(plan.everyDays) : null,
                fromDate: today(),
                fromReading: d.maintenance.reading ?? '0',
              },
              'Plan added.',
            );
          }}
        >
          <Field label="Plan">
            <Input
              value={plan.name}
              onChange={(e) => setPlan({ ...plan, name: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Every hours">
            <Input
              className="w-24"
              value={plan.everyHours}
              onChange={(e) => setPlan({ ...plan, everyHours: e.target.value })}
            />
          </Field>
          <Field label="Every days">
            <Input
              className="w-24"
              value={plan.everyDays}
              onChange={(e) => setPlan({ ...plan, everyDays: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Add a plan
          </Button>
        </form>
      )}
    </Card>
  );
}

function Costing({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const [month, setMonth] = useState(prevMonth());
  const key = ['equipment-costing', entityId, month];
  const c = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{
        internalTotal: string;
        own: { equipment: string; qty: string; amount: string }[];
        hired: { equipment: string; name: string; total: string }[];
        done: { voucher: string | null; hireBills: { billNo: string; total: string }[] } | null;
      }>(`/api/tenant/equipment/costing?entityId=${entityId}&month=${month}`),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Month's costing">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Month">
        <Input
          type="month"
          className="w-44"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      </Field>
      {c.data && (
        <div className="mt-3 space-y-2 text-sm" aria-label="Costing">
          <p>
            Own machines charged to projects: {rupees(c.data.internalTotal)} ({c.data.own.length}{' '}
            lines).
          </p>
          {c.data.hired.map((h) => (
            <p key={h.equipment}>
              {h.equipment} {h.name}: hire {rupees(h.total)} before GST.
            </p>
          ))}
          {c.data.done ? (
            <p className="text-success">
              Costed: {c.data.done.voucher ?? 'no internal charge'}; bills{' '}
              {c.data.done.hireBills.map((b) => b.billNo).join(', ') || 'none'}.
            </p>
          ) : (
            mayPost &&
            (c.data.own.length > 0 || c.data.hired.length > 0) && (
              <Button
                type="button"
                onClick={() =>
                  void api
                    .request('/api/tenant/equipment/costing', {
                      method: 'POST',
                      body: { entityId, month },
                    })
                    .then(() => qc.invalidateQueries({ queryKey: key }))
                    .catch((err: unknown) => setError(describeError(err)))
                }
              >
                Post the month
              </Button>
            )
          )}
        </div>
      )}
    </Card>
  );
}

function Fuel({ entityId }: { entityId: string }) {
  const [month, setMonth] = useState(monthOf(today()));
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const f = useQuery({
    queryKey: ['fuel', entityId, month],
    queryFn: () =>
      api.request<{
        rows: {
          id: string;
          code: string;
          name: string;
          worked: string;
          litres: string;
          perUnit: string | null;
          norm: string | null;
          offPct: number | null;
          flagged: boolean;
        }[];
      }>(`/api/tenant/equipment/fuel?entityId=${entityId}&from=${month}-01&to=${last}`),
  });
  return (
    <Card title="Fuel">
      <Field label="Month">
        <Input
          type="month"
          className="w-44"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      </Field>
      {f.data && f.data.rows.length > 0 && (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Machine</th>
              <th className="text-right">Worked</th>
              <th className="text-right">Litres</th>
              <th className="text-right">Per hour</th>
              <th className="text-right">Norm</th>
            </tr>
          </thead>
          <tbody aria-label="Fuel">
            {f.data.rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.code} {r.name}{' '}
                  {r.flagged && (
                    <Badge tone="warning">
                      {r.offPct! > 0 ? '+' : ''}
                      {r.offPct}%
                    </Badge>
                  )}
                </td>
                <td className="text-right tabular-nums">{Number(r.worked)}</td>
                <td className="text-right tabular-nums">{Number(r.litres)}</td>
                <td className="text-right tabular-nums">{r.perUnit ?? '-'}</td>
                <td className="text-right tabular-nums">{r.norm ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
