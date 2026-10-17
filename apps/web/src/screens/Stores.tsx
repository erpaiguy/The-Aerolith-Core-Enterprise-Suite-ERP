// Stores across the projects I am on, and the stock valuation method (docs/wave2b-plan.md step 6). A store is made for
// a site the first time goods are received there; more are set up from a project's page.
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
import { useState } from 'react';
import { api } from '../api/client';
import { useRun } from '../approvals/model';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import type { StoreRow } from '../procurement/inventory';
import { usePermission } from '../session/permissions';
import { useSession } from '../session/session';

export function StoresScreen() {
  const rows = useQuery({
    queryKey: ['stores', 'all'],
    queryFn: () => api.request<StoreRow[]>('/api/tenant/stores'),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Stores"
        subtitle="What is in the stores of the projects you are on, and what it is worth. A site's store is made when goods are first received there."
      />
      <Card>
        {rows.isPending ? (
          <Spinner />
        ) : rows.isError ? (
          <Alert tone="danger">{describeError(rows.error)}</Alert>
        ) : (
          <StoreTable rows={rows.data} showProject />
        )}
      </Card>
      <CentralStore />
      <Valuation />
    </div>
  );
}

/** A company's central store, not tied to a project (docs/wave8-plan.md step 8e.3). */
function CentralStore() {
  const qc = useQueryClient();
  const may = usePermission('stores.manage');
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () =>
      api.request<{ companies: { id: string; name: string }[] }>('/api/tenant/companies'),
    select: (r) => r.companies,
    enabled: may,
  });
  const [form, setForm] = useState({ entityId: '', name: '', yard: '', stateCode: '27' });
  const { run, busy, error } = useRun(() => {
    void qc.invalidateQueries({ queryKey: ['stores'] });
    setForm({ ...form, name: '' });
  });
  if (!may) return null;
  const entityId = form.entityId || companies.data?.[0]?.id || '';
  return (
    <Card title="Central store">
      <p className="mb-3 text-sm text-fg-muted">
        A company store at a yard, not tied to a project: projects send to it and draw from it by
        transfer.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <form
        aria-label="New central store"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run('central', () =>
            api.request('/api/tenant/stores/central', {
              method: 'POST',
              body: {
                entityId,
                name: form.name,
                yard: form.yard,
                stateCode: form.stateCode || null,
              },
            }),
          );
        }}
      >
        {(companies.data?.length ?? 0) > 1 && (
          <Field label="Company">
            <Select
              value={entityId}
              onChange={(e) => setForm({ ...form, entityId: e.target.value })}
            >
              {companies.data!.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Store name">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Yard">
          <Input
            value={form.yard}
            onChange={(e) => setForm({ ...form, yard: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="GST state code">
          <Input
            value={form.stateCode}
            className="w-16"
            pattern="\d{2}"
            onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="secondary" busy={busy === 'central'}>
          Add central store
        </Button>
      </form>
    </Card>
  );
}

export function StoreTable({
  rows,
  showProject = false,
}: {
  rows: StoreRow[];
  showProject?: boolean;
}) {
  if (!rows.length) return <p className="text-sm text-fg-muted">None yet.</p>;
  return (
    <Table minWidth="36rem">
      <thead>
        <tr>
          <th>Store</th>
          {showProject && <th>Project</th>}
          <th className="text-right">Materials</th>
          <th className="text-right">Value</th>
        </tr>
      </thead>
      <tbody aria-label="Stores">
        {rows.map((s) => (
          <tr key={s.id}>
            <td>
              <Link
                to="/stores/$storeId"
                params={{ storeId: s.id }}
                className="text-accent hover:underline"
              >
                {s.name}
              </Link>
              <span className="block text-xs text-fg-muted">at {s.site.name}</span>
            </td>
            {showProject && (
              <td className="text-sm">
                {s.project.number} · {s.project.name}
              </td>
            )}
            <td className="text-right tabular-nums">
              {s.items}
              {s.below > 0 && (
                <>
                  {' '}
                  <Badge tone="warning">{s.below} below reorder</Badge>
                </>
              )}
            </td>
            <td className="text-right tabular-nums">{rupees(s.value)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Weighted average or FIFO: chosen by the admin before anything moves, then fixed. */
function Valuation() {
  const { user } = useSession();
  const qc = useQueryClient();
  const v = useQuery({
    queryKey: ['stock-valuation'],
    queryFn: () =>
      api.request<{ method: 'average' | 'fifo'; changeable: boolean }>(
        '/api/tenant/stock/valuation',
      ),
  });
  const [method, setMethod] = useState<string | null>(null);
  const { run, busy, error } = useRun(
    () => void qc.invalidateQueries({ queryKey: ['stock-valuation'] }),
  );
  if (!v.data) return null;
  const label = v.data.method === 'fifo' ? 'First in, first out (FIFO)' : 'Weighted average';
  return (
    <Card title="Stock valuation">
      <p className="text-sm" data-testid="valuation">
        {label}, per store and material.{' '}
        {v.data.changeable
          ? 'It can be changed until the first stock moves, then it is fixed.'
          : 'Fixed: stock has moved.'}
      </p>
      {user?.role === 'admin' && v.data.changeable && (
        <div className="mt-3 flex items-end gap-2">
          <div className="w-64">
            <Field label="Method">
              <Select value={method ?? v.data.method} onChange={(e) => setMethod(e.target.value)}>
                <option value="average">Weighted average</option>
                <option value="fifo">First in, first out (FIFO)</option>
              </Select>
            </Field>
          </div>
          <Button
            variant="secondary"
            busy={busy === 'set'}
            disabled={!method || method === v.data.method}
            onClick={() =>
              void run('set', () =>
                api.request('/api/tenant/stock/valuation', { method: 'POST', body: { method } }),
              )
            }
          >
            Save
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
