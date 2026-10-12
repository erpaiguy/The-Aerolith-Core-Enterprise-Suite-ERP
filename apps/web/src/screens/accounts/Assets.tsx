// Fixed assets (docs/wave3-plan.md step 9): the register, an asset registered from a supplier's bill or the opening
// balances, its transfers and disposal; depreciation runs (posted, reversed); the Income Tax blocks for a year.
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { fyOf, today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from './Vouchers';

interface Row {
  id: string;
  number: string;
  name: string;
  class: string;
  status: 'active' | 'disposed';
  putToUseOn: string;
  cost: string;
  bookValue: string;
  project: string | null;
}
interface AssetClass {
  id: string;
  name: string;
  lifeYears: string;
  method: 'slm' | 'wdv';
  residualPct: string;
  itRate: string;
  account: { id: string; code: string; name: string };
}
interface Run {
  id: string;
  upto: string;
  total: string;
  voucher: string | null;
  reversed: boolean;
  lines: number;
}

export function AssetsScreen() {
  return (
    <Books title="Fixed assets">
      {(entityId) => (
        <>
          <Register entityId={entityId} />
          <Runs entityId={entityId} />
          <Tax entityId={entityId} />
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

function Register({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const key = ['assets', entityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.request<Row[]>(`/api/tenant/accounts/assets?entityId=${entityId}`),
  });
  const classes = useQuery({
    queryKey: ['asset-classes'],
    queryFn: () => api.request<AssetClass[]>('/api/tenant/accounts/asset-classes'),
  });
  const projects = useProjects();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState({
    name: '',
    classId: '',
    source: 'bill',
    vendorBillId: '',
    purchasedOn: today(),
    putToUseOn: today(),
    cost: '',
    openingDepreciation: '',
    itOpeningWdv: '',
    serialNo: '',
    projectId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['depreciation-runs', entityId] });
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.request('/api/tenant/accounts/assets', {
        method: 'POST',
        body: {
          entityId,
          name: f.name,
          classId: f.classId || classes.data?.[0]?.id,
          source: f.source,
          vendorBillId: f.source === 'bill' ? f.vendorBillId || null : null,
          purchasedOn: f.purchasedOn,
          putToUseOn: f.putToUseOn,
          cost: f.cost,
          openingDepreciation: f.source === 'opening' ? f.openingDepreciation || '0' : '0',
          itOpeningWdv: f.source === 'opening' && f.itOpeningWdv ? f.itOpeningWdv : null,
          serialNo: f.serialNo,
          projectId: f.projectId || null,
        },
      });
      setAdding(false);
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const bills = useQuery({
    queryKey: ['vendor-bills', entityId, 'posted'],
    queryFn: () =>
      api.request<{ id: string; party: string; billNo: string; total: string }[]>(
        `/api/tenant/accounts/vendor-bills?entityId=${entityId}&status=posted`,
      ),
    enabled: adding,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Card
      title="Register"
      actions={
        mayPost &&
        !adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            Register an asset
          </Button>
        )
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {adding && (
        <form
          aria-label="New asset"
          className="mb-4 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => void add(e)}
        >
          <Field label="Name">
            <Input value={f.name} onChange={set('name')} required minLength={2} />
          </Field>
          <Field label="Class">
            <Select value={f.classId || classes.data?.[0]?.id || ''} onChange={set('classId')}>
              {(classes.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.method === 'slm' ? 'straight line' : 'WDV'}, {Number(c.lifeYears)}{' '}
                  years)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Came from">
            <Select value={f.source} onChange={set('source')}>
              <option value="bill">A supplier's bill</option>
              <option value="opening">The opening balances</option>
            </Select>
          </Field>
          {f.source === 'bill' ? (
            <Field label="Bill">
              <Select value={f.vendorBillId} onChange={set('vendorBillId')} required>
                <option value="">Which bill?</option>
                {(bills.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.party} {b.billNo} ({rupees(b.total)})
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field label="Depreciation to date ₹">
                <Input value={f.openingDepreciation} onChange={set('openingDepreciation')} />
              </Field>
              <Field label="Tax written-down value ₹">
                <Input value={f.itOpeningWdv} onChange={set('itOpeningWdv')} />
              </Field>
            </>
          )}
          <Field label="Cost ₹">
            <Input value={f.cost} onChange={set('cost')} required />
          </Field>
          <Field label="Bought on">
            <Input type="date" value={f.purchasedOn} onChange={set('purchasedOn')} required />
          </Field>
          <Field label="Put to use on">
            <Input type="date" value={f.putToUseOn} onChange={set('putToUseOn')} required />
          </Field>
          <Field label="Project">
            <Select value={f.projectId} onChange={set('projectId')}>
              <option value="">None (head office)</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Serial no.">
            <Input value={f.serialNo} onChange={set('serialNo')} maxLength={100} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" busy={busy}>
              Register
            </Button>
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
        <p className="text-sm text-fg-muted">No assets registered.</p>
      ) : (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Class</th>
              <th>Project</th>
              <th className="text-right">Cost</th>
              <th className="text-right">Book value</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Assets">
            {list.data.map((a) => (
              <tr key={a.id} className="align-top">
                <td>
                  <span className="font-mono text-xs text-fg-muted">{a.number}</span> {a.name}
                  {a.status === 'disposed' && (
                    <>
                      {' '}
                      <Badge>Disposed</Badge>
                    </>
                  )}
                  {open === a.id && <AssetActions id={a.id} onDone={refresh} />}
                </td>
                <td>{a.class}</td>
                <td>{a.project ?? '-'}</td>
                <td className="text-right tabular-nums">{rupees(a.cost)}</td>
                <td className="text-right tabular-nums">{rupees(a.bookValue)}</td>
                <td>
                  {mayPost && a.status === 'active' && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setOpen(open === a.id ? null : a.id)}
                    >
                      {open === a.id ? 'Close' : 'Move or sell'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function AssetActions({ id, onDone }: { id: string; onDone: () => void }) {
  const projects = useProjects();
  const chart = useChart();
  const banks = (chart.data?.accounts ?? []).filter(
    (a) => (a.kind === 'bank' || a.kind === 'cash') && !a.closed,
  );
  const [move, setMove] = useState({ date: today(), projectId: '' });
  const [sale, setSale] = useState({ date: today(), proceeds: '', bankAccountId: '' });
  const [error, setError] = useState<string | null>(null);
  const call = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(`/api/tenant/accounts/assets/${id}/${path}`, { method: 'POST', body });
      onDone();
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="mt-2 space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      <form
        aria-label="Transfer"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call('transfer', { date: move.date, projectId: move.projectId || null });
        }}
      >
        <Field label="Moved on">
          <Input
            type="date"
            className="w-40"
            value={move.date}
            onChange={(e) => setMove({ ...move, date: e.target.value })}
          />
        </Field>
        <Field label="To project">
          <Select
            value={move.projectId}
            onChange={(e) => setMove({ ...move, projectId: e.target.value })}
          >
            <option value="">None (head office)</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          Transfer
        </Button>
      </form>
      <form
        aria-label="Dispose"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            window.confirm(
              'Dispose of the asset? Its depreciation to the day before is posted first.',
            )
          )
            void call('dispose', {
              date: sale.date,
              proceeds: sale.proceeds || '0',
              bankAccountId: Number(sale.proceeds) > 0 ? sale.bankAccountId || banks[0]?.id : null,
            });
        }}
      >
        <Field label="Sold on">
          <Input
            type="date"
            className="w-40"
            value={sale.date}
            onChange={(e) => setSale({ ...sale, date: e.target.value })}
          />
        </Field>
        <Field label="For ₹">
          <Input
            className="w-32"
            value={sale.proceeds}
            onChange={(e) => setSale({ ...sale, proceeds: e.target.value })}
          />
        </Field>
        <Field label="Into">
          <Select
            value={sale.bankAccountId}
            onChange={(e) => setSale({ ...sale, bankAccountId: e.target.value })}
          >
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          Dispose
        </Button>
      </form>
    </div>
  );
}

function Runs({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const mayPost = usePermission('accounts.post');
  const key = ['depreciation-runs', entityId];
  const runs = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Run[]>(`/api/tenant/accounts/depreciation-runs?entityId=${entityId}`),
  });
  const [upto, setUpto] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['assets', entityId] });
  };
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.request<{ total: string; voucher: string }>(
        '/api/tenant/accounts/depreciation-runs',
        {
          method: 'POST',
          body: { entityId, upto },
        },
      );
      setNote(`${rupees(r.total)} depreciation posted (${r.voucher}).`);
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Depreciation">
      {error && <Alert tone="danger">{error}</Alert>}
      {note && (
        <p className="text-sm" aria-label="Run result">
          {note}
        </p>
      )}
      {mayPost && (
        <form
          aria-label="Depreciation run"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => void run(e)}
        >
          <Field label="Up to">
            <Input
              type="date"
              className="w-40"
              value={upto}
              onChange={(e) => setUpto(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" busy={busy}>
            Run depreciation
          </Button>
        </form>
      )}
      {(runs.data?.length ?? 0) > 0 && (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Up to</th>
              <th>Voucher</th>
              <th className="text-right">Assets</th>
              <th className="text-right">Charged</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Depreciation runs">
            {runs.data!.map((r) => (
              <tr key={r.id}>
                <td>{shortDate(r.upto)}</td>
                <td className="font-mono text-xs">{r.voucher}</td>
                <td className="text-right">{r.lines}</td>
                <td className="text-right tabular-nums">{rupees(r.total)}</td>
                <td>
                  {r.reversed ? (
                    <Badge>Reversed</Badge>
                  ) : (
                    mayPost && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          const reason = window.prompt('Why is the run reversed?');
                          if (reason && reason.trim().length >= 3)
                            void api
                              .request(`/api/tenant/accounts/depreciation-runs/${r.id}/reverse`, {
                                method: 'POST',
                                body: { date: r.upto, reason: reason.trim() },
                              })
                              .then(refresh)
                              .catch((err: unknown) => setError(describeError(err)));
                        }}
                      >
                        Reverse
                      </Button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Tax({ entityId }: { entityId: string }) {
  const [fy, setFy] = useState(fyOf(today()).label);
  const t = useQuery({
    queryKey: ['tax-depreciation', entityId, fy],
    queryFn: () =>
      api.request<{
        blocks: {
          block: string;
          opening: string;
          additionsFull: string;
          additionsHalf: string;
          sales: string;
          depreciation: string;
          closing: string;
        }[];
      }>(`/api/tenant/accounts/assets/tax-depreciation?entityId=${entityId}&fy=${fy}`),
    enabled: /^\d{4}-\d{2}$/.test(fy),
  });
  return (
    <Card title="Income Tax depreciation">
      <Field label="Financial year">
        <Input className="w-28" value={fy} onChange={(e) => setFy(e.target.value)} />
      </Field>
      {t.data && t.data.blocks.length > 0 && (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Block</th>
              <th className="text-right">Opening</th>
              <th className="text-right">Added, 180 days or more</th>
              <th className="text-right">Added, fewer</th>
              <th className="text-right">Sales</th>
              <th className="text-right">Depreciation</th>
              <th className="text-right">Closing</th>
            </tr>
          </thead>
          <tbody aria-label="Tax blocks">
            {t.data.blocks.map((b) => (
              <tr key={b.block}>
                <td>{b.block}</td>
                <td className="text-right tabular-nums">{rupees(b.opening)}</td>
                <td className="text-right tabular-nums">{rupees(b.additionsFull)}</td>
                <td className="text-right tabular-nums">{rupees(b.additionsHalf)}</td>
                <td className="text-right tabular-nums">{rupees(b.sales)}</td>
                <td className="text-right tabular-nums">{rupees(b.depreciation)}</td>
                <td className="text-right tabular-nums">{rupees(b.closing)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
