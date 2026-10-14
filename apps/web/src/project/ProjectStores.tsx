// A project's stores on its page (docs/wave2b-plan.md step 6): what each holds, a new one, and the consumption report.
import { Alert, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { useRun } from '../approvals/model';
import { formatQty } from '../boq/model';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import type { StoreRow } from '../procurement/inventory';
import { StoreTable } from '../screens/Stores';
import { usePermission } from '../session/permissions';
import { EstimateVsActual, MaterialReconciliation } from './Reconciliation';

export function ProjectStores({ project: p }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const canManage = usePermission('stores.manage');
  const mayCreate = canManage && (p.canEdit || p.myRole === 'lead' || p.myRole === 'member');
  const stores = useQuery({
    queryKey: ['stores', 'project', p.id],
    queryFn: () => api.request<StoreRow[]>(`/api/tenant/stores?projectId=${p.id}`),
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState(p.sites[0]?.id ?? '');
  const { run, busy, error } = useRun(() => {
    setAdding(false);
    setName('');
    void qc.invalidateQueries({ queryKey: ['stores'] });
  });
  return (
    <Card
      title={`Stores${stores.data ? ` (${stores.data.length})` : ''}`}
      actions={
        <div className="flex items-center gap-3">
          <Link
            to="/projects/$projectId/consumption"
            params={{ projectId: p.id }}
            className="text-sm text-accent hover:underline"
          >
            Consumption
          </Link>
          {mayCreate && !adding && p.sites.length > 0 && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> New store
            </Button>
          )}
        </div>
      }
    >
      {adding && (
        <form
          className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
          aria-label="New store"
          onSubmit={(e) => {
            e.preventDefault();
            void run('add', () =>
              api.request(`/api/tenant/projects/${p.id}/stores`, {
                method: 'POST',
                body: { siteId, name: name.trim() },
              }),
            );
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="Store name">
              <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div className="w-48">
            <Field label="At site">
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {p.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" busy={busy === 'add'} disabled={name.trim().length < 2}>
            Add store
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {stores.isPending ? (
        <Spinner />
      ) : stores.isError ? (
        <Alert tone="danger">{describeError(stores.error)}</Alert>
      ) : (
        <StoreTable rows={stores.data} />
      )}
    </Card>
  );
}

interface Consumption {
  resources: {
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    budget: string | null;
    received: string;
    issued: string;
    issuedValue: string;
    inStock: string;
    stockValue: string;
  }[];
  byWbs: {
    wbsCode: string;
    wbsName: string;
    code: string;
    name: string;
    unit: string;
    qty: string;
    value: string;
  }[];
}

/** Material by material: the budget in force, received, issued to work (net of returns), in the stores. */
export function ConsumptionScreen({ projectId }: { projectId: string }) {
  const c = useQuery({
    queryKey: ['consumption', projectId],
    queryFn: () => api.request<Consumption>(`/api/tenant/projects/${projectId}/consumption`),
  });
  const p = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  if (c.isPending) return <Spinner />;
  if (c.isError) return <Alert tone="danger">{describeError(c.error)}</Alert>;
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="text-sm text-fg-muted hover:underline"
      >
        ← {p.data ? `${p.data.number} · ${p.data.name}` : 'Project'}
      </Link>
      <h1 className="text-xl font-semibold">Material consumption</h1>
      <Card title="By material">
        {c.data.resources.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing budgeted, received or issued yet.</p>
        ) : (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Budget</th>
                <th className="text-right">Received</th>
                <th className="text-right">Issued</th>
                <th className="text-right">Issued value</th>
                <th className="text-right">Budget left</th>
                <th className="text-right">In stores</th>
              </tr>
            </thead>
            <tbody aria-label="Consumption">
              {c.data.resources.map((r) => {
                const left = r.budget === null ? null : Number(r.budget) - Number(r.issued);
                return (
                  <tr key={r.resourceId}>
                    <td>
                      <span className="mr-2 font-mono text-xs">{r.code}</span>
                      {r.name} <span className="text-fg-muted">{r.unit}</span>
                    </td>
                    <td className="text-right tabular-nums">
                      {r.budget ? formatQty(r.budget) : '-'}
                    </td>
                    <td className="text-right tabular-nums">{formatQty(r.received)}</td>
                    <td className="text-right tabular-nums">{formatQty(r.issued)}</td>
                    <td className="text-right tabular-nums">{rupees(r.issuedValue)}</td>
                    <td
                      className={`text-right tabular-nums ${left !== null && left < 0 ? 'text-danger' : ''}`}
                    >
                      {left === null ? '-' : formatQty(String(left))}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatQty(r.inStock)}
                      <span className="block text-xs text-fg-muted">{rupees(r.stockValue)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {c.data.byWbs.length > 0 && (
        <Card title="Issued by WBS element">
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>WBS</th>
                <th>Material</th>
                <th className="text-right">Issued</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody aria-label="By WBS">
              {c.data.byWbs.map((w) => (
                <tr key={`${w.wbsCode}-${w.code}`}>
                  <td>
                    <span className="font-mono text-xs">{w.wbsCode}</span> {w.wbsName}
                  </td>
                  <td>{w.name}</td>
                  <td className="text-right tabular-nums">
                    {formatQty(w.qty)} {w.unit}
                  </td>
                  <td className="text-right tabular-nums">{rupees(w.value)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <MaterialReconciliation projectId={projectId} />
      <EstimateVsActual projectId={projectId} />
    </div>
  );
}
