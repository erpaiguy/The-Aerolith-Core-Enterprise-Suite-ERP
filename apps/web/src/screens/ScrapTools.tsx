// Scrap and tools for a project (docs/wave8-plan.md step 8e.5): scrap noted on site and sold to a scrap buyer with
// GST; returnable tools issued to a person or gang, with what is overdue, back or lost.
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
import { api } from '../api/client';
import type { ProjectSummary } from '../api/types';
import { today } from '../accounts/model';
import { describeError } from '../lib/format';
import { useProjectParam } from '../lib/project-param';
import { rupees } from '../procurement/OrderLines';

const SOURCES = {
  cut_ends: 'Cut ends',
  packing: 'Packing',
  demolition: 'Demolition',
  damaged: 'Damaged',
  other: 'Other',
};
interface Scrap {
  balances: { material: string; unit: string; noted: string; sold: string; onHand: string }[];
  entries: {
    id: string;
    material: string;
    unit: string;
    qty: string;
    source: keyof typeof SOURCES;
    notedOn: string;
  }[];
  sales: {
    id: string;
    number: string;
    buyer: string;
    soldOn: string;
    amount: string;
    gst: string;
    total: string;
    voucher: string;
  }[];
  mayManage: boolean;
}
interface Tools {
  issues: {
    id: string;
    tool: string;
    qty: number;
    issuedTo: string;
    issuedOn: string;
    dueOn: string;
    returned: number;
    lost: number;
    out: number;
    closedOn: string | null;
    overdue: boolean;
    note: string;
  }[];
  mayManage: boolean;
}

export function ScrapToolsScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Scrap and tools"
        subtitle="Scrap noted and sold; returnable tools out with people and gangs."
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
      />
      {projectId ? (
        <>
          <ScrapCard key={`s${projectId}`} projectId={projectId} />
          <ToolsCard key={`t${projectId}`} projectId={projectId} />
        </>
      ) : (
        <OverdueTools />
      )}
    </div>
  );
}

function useAction(key: unknown[]) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request(path, { method: 'POST', body }));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  return { run, error };
}

function ScrapCard({ projectId }: { projectId: string }) {
  const key = ['scrap', projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Scrap>(`/api/tenant/projects/${projectId}/scrap`),
  });
  const sites = useQuery({
    queryKey: ['project', projectId],
    queryFn: () =>
      api.request<{ sites: { id: string; name: string }[] }>(`/api/tenant/projects/${projectId}`),
  });
  const parties = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => api.request<{ id: string; name: string }[]>('/api/tenant/parties'),
  });
  const { run, error } = useAction(key);
  const [entry, setEntry] = useState({
    material: '',
    unit: 't',
    qty: '',
    source: 'cut_ends',
    notedOn: today(),
  });
  const [sale, setSale] = useState({
    partyId: '',
    siteId: '',
    material: '',
    qty: '',
    rate: '',
    gstPct: '18',
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const pick = d.balances.find((b) => b.material === sale.material);
  return (
    <Card title="Scrap">
      {error && <Alert tone="danger">{error}</Alert>}
      {d.balances.length > 0 && (
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Material</th>
              <th className="text-right">Noted</th>
              <th className="text-right">Sold</th>
              <th className="text-right">On hand</th>
            </tr>
          </thead>
          <tbody aria-label="Scrap on hand">
            {d.balances.map((b) => (
              <tr key={b.material + b.unit}>
                <td>{b.material}</td>
                <td className="text-right tabular-nums">
                  {Number(b.noted)} {b.unit}
                </td>
                <td className="text-right tabular-nums">{Number(b.sold)}</td>
                <td className="text-right tabular-nums">{Number(b.onHand)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {d.mayManage && (
        <form
          aria-label="Note scrap"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`/api/tenant/projects/${projectId}/scrap`, entry).then(
              (ok) => ok && setEntry({ ...entry, qty: '' }),
            );
          }}
        >
          <Field label="Scrap">
            <Input
              value={entry.material}
              onChange={(e) => setEntry({ ...entry, material: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Quantity">
            <Input
              inputMode="decimal"
              className="w-24"
              value={entry.qty}
              onChange={(e) => setEntry({ ...entry, qty: e.target.value })}
              required
            />
          </Field>
          <Field label="Unit">
            <Input
              className="w-16"
              value={entry.unit}
              onChange={(e) => setEntry({ ...entry, unit: e.target.value })}
              required
            />
          </Field>
          <Field label="From">
            <Select
              value={entry.source}
              onChange={(e) => setEntry({ ...entry, source: e.target.value })}
            >
              {Object.entries(SOURCES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="On">
            <Input
              type="date"
              value={entry.notedOn}
              onChange={(e) => setEntry({ ...entry, notedOn: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Note scrap
          </Button>
        </form>
      )}
      {d.mayManage && d.balances.some((b) => Number(b.onHand) > 0) && (
        <form
          aria-label="Sell scrap"
          className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`/api/tenant/projects/${projectId}/scrap-sales`, {
              partyId: sale.partyId,
              siteId: sale.siteId || sites.data?.sites[0]?.id,
              soldOn: today(),
              lines: [
                {
                  material: sale.material,
                  unit: pick?.unit ?? '',
                  qty: sale.qty,
                  rate: sale.rate,
                  gstPct: sale.gstPct,
                },
              ],
            }).then((ok) => ok && setSale({ ...sale, qty: '', rate: '' }));
          }}
        >
          <Field label="Buyer">
            <Select
              value={sale.partyId}
              onChange={(e) => setSale({ ...sale, partyId: e.target.value })}
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
          {(sites.data?.sites.length ?? 0) > 1 && (
            <Field label="From site">
              <Select
                value={sale.siteId}
                onChange={(e) => setSale({ ...sale, siteId: e.target.value })}
              >
                {sites.data!.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Scrap sold">
            <Select
              value={sale.material}
              onChange={(e) => setSale({ ...sale, material: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {d.balances
                .filter((b) => Number(b.onHand) > 0)
                .map((b) => (
                  <option key={b.material} value={b.material}>
                    {b.material} ({Number(b.onHand)} {b.unit})
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Sold quantity">
            <Input
              inputMode="decimal"
              className="w-24"
              value={sale.qty}
              onChange={(e) => setSale({ ...sale, qty: e.target.value })}
              required
            />
          </Field>
          <Field label={`Rate per ${pick?.unit ?? 'unit'} ₹`}>
            <Input
              inputMode="decimal"
              className="w-28"
              value={sale.rate}
              onChange={(e) => setSale({ ...sale, rate: e.target.value })}
              required
            />
          </Field>
          <Field label="GST %">
            <Input
              inputMode="decimal"
              className="w-16"
              value={sale.gstPct}
              onChange={(e) => setSale({ ...sale, gstPct: e.target.value })}
            />
          </Field>
          <Button type="submit">Sell</Button>
        </form>
      )}
      {d.sales.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm" aria-label="Scrap sales">
          {d.sales.map((s) => (
            <li key={s.id}>
              {s.number} {s.soldOn} to {s.buyer}: {rupees(s.amount)} + GST {rupees(s.gst)} ={' '}
              {rupees(s.total)} <span className="text-fg-muted">({s.voucher})</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ToolsCard({ projectId }: { projectId: string }) {
  const key = ['tools', projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Tools>(`/api/tenant/projects/${projectId}/tools`),
  });
  const { run, error } = useAction(key);
  const [form, setForm] = useState({
    tool: '',
    qty: '1',
    issuedTo: '',
    issuedOn: today(),
    dueOn: today(),
  });
  const [back, setBack] = useState<
    Record<string, { returned: string; lost: string; note: string }>
  >({});
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  return (
    <Card title="Returnable tools">
      {error && <Alert tone="danger">{error}</Alert>}
      {d.issues.length > 0 && (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Tool</th>
              <th>With</th>
              <th>Due back</th>
              <th className="text-right">Out</th>
              <th>Back / lost</th>
            </tr>
          </thead>
          <tbody aria-label="Tools out">
            {d.issues.map((t) => {
              const b = back[t.id] ?? { returned: '', lost: '', note: '' };
              return (
                <tr key={t.id}>
                  <td>
                    {t.qty} × {t.tool}
                  </td>
                  <td>{t.issuedTo}</td>
                  <td>
                    {t.dueOn} {t.overdue && <Badge tone="danger">overdue</Badge>}
                    {t.closedOn && <Badge tone="success">closed {t.closedOn}</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{t.out}</td>
                  <td>
                    {t.closedOn || !d.mayManage ? (
                      `${t.returned} back${t.lost ? `, ${t.lost} lost` : ''}`
                    ) : (
                      <form
                        aria-label={`Return ${t.tool}`}
                        className="flex flex-wrap gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(`/api/tenant/tool-issues/${t.id}/return`, {
                            returned: Number(b.returned || 0),
                            lost: Number(b.lost || 0),
                            on: today(),
                            note: b.note,
                          });
                        }}
                      >
                        <Input
                          aria-label="Back"
                          placeholder="Back"
                          className="w-16"
                          value={b.returned}
                          onChange={(e) =>
                            setBack({ ...back, [t.id]: { ...b, returned: e.target.value } })
                          }
                        />
                        <Input
                          aria-label="Lost"
                          placeholder="Lost"
                          className="w-16"
                          value={b.lost}
                          onChange={(e) =>
                            setBack({ ...back, [t.id]: { ...b, lost: e.target.value } })
                          }
                        />
                        {Number(b.lost) > 0 && (
                          <Input
                            aria-label="How lost"
                            placeholder="How lost"
                            value={b.note}
                            onChange={(e) =>
                              setBack({ ...back, [t.id]: { ...b, note: e.target.value } })
                            }
                          />
                        )}
                        <Button type="submit" variant="ghost">
                          Record
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {d.mayManage && (
        <form
          aria-label="Issue a tool"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`/api/tenant/projects/${projectId}/tools`, {
              ...form,
              qty: Number(form.qty),
            }).then((ok) => ok && setForm({ ...form, tool: '', qty: '1' }));
          }}
        >
          <Field label="Tool">
            <Input
              value={form.tool}
              onChange={(e) => setForm({ ...form, tool: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="How many">
            <Input
              inputMode="numeric"
              className="w-16"
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
              required
            />
          </Field>
          <Field label="To (person or gang)">
            <Input
              value={form.issuedTo}
              onChange={(e) => setForm({ ...form, issuedTo: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Issued on">
            <Input
              type="date"
              value={form.issuedOn}
              onChange={(e) => setForm({ ...form, issuedOn: e.target.value })}
            />
          </Field>
          <Field label="Due back">
            <Input
              type="date"
              value={form.dueOn}
              onChange={(e) => setForm({ ...form, dueOn: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Issue
          </Button>
        </form>
      )}
    </Card>
  );
}

function OverdueTools() {
  const q = useQuery({
    queryKey: ['overdue-tools'],
    queryFn: () =>
      api.request<
        {
          id: string;
          project: string;
          tool: string;
          out: number;
          issuedTo: string;
          dueOn: string;
          daysLate: number;
        }[]
      >('/api/tenant/procurement/overdue-tools'),
  });
  return (
    <Card title="Tools overdue on all projects">
      {q.isPending ? (
        <Spinner />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-fg-muted">None overdue.</p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Tools overdue">
          {q.data!.map((t) => (
            <li key={t.id}>
              {t.project}: {t.out} × {t.tool} with {t.issuedTo}, due {t.dueOn} ({t.daysLate} days
              late)
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
