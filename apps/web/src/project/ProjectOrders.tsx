// A project's purchase and work orders on its page (docs/wave2b-plan.md step 4), and a new one written directly. Most
// come from the vendors chosen in an enquiry, made on the enquiry's page.
import { Alert, Button, Card, Field, Select, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Party, ProjectDetail } from '../api/types';
import { useRun } from '../approvals/model';
import { describeError } from '../lib/format';
import type { Order, OrderKind, OrderRow } from '../procurement/orders';
import { OrderTable } from '../screens/Orders';
import { usePermission } from '../session/permissions';

export function ProjectOrders({ project: p }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const canOrder = usePermission('purchase.edit');
  const mayStart = canOrder && (p.canEdit || p.myRole === 'lead' || p.myRole === 'member');
  const orders = useQuery({
    queryKey: ['orders', 'project', p.id],
    queryFn: () => api.request<OrderRow[]>(`/api/tenant/orders?projectId=${p.id}`),
  });
  const [starting, setStarting] = useState(false);
  const [fromReq, setFromReq] = useState(false);
  return (
    <Card
      title={`Orders${orders.data ? ` (${orders.data.length})` : ''}`}
      actions={
        mayStart &&
        !starting &&
        !fromReq && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setFromReq(true)}>
              From requisitions
            </Button>
            <Button variant="secondary" onClick={() => setStarting(true)}>
              <Plus className="size-4" aria-hidden /> New order
            </Button>
          </div>
        )
      }
    >
      {fromReq && (
        <FromRequisitions
          project={p}
          onCancel={() => setFromReq(false)}
          onMade={(id) => void navigate({ to: '/orders/$orderId', params: { orderId: id } })}
        />
      )}
      {starting && (
        <NewOrder
          project={p}
          onCancel={() => setStarting(false)}
          onMade={(id) => void navigate({ to: '/orders/$orderId', params: { orderId: id } })}
        />
      )}
      {orders.isPending ? (
        <Spinner />
      ) : orders.isError ? (
        <Alert tone="danger">{describeError(orders.error)}</Alert>
      ) : orders.data.length === 0 ? (
        <p className="text-sm text-fg-muted">
          None yet. Make them from the vendors chosen in an enquiry, or write one here.
        </p>
      ) : (
        <OrderTable rows={orders.data} />
      )}
    </Card>
  );
}

function NewOrder({
  project: p,
  onCancel,
  onMade,
}: {
  project: ProjectDetail;
  onCancel: () => void;
  onMade: (id: string) => void;
}) {
  const [kind, setKind] = useState<OrderKind>('purchase');
  const vendors = useQuery({
    queryKey: ['parties', kind === 'work' ? 'subcontractor' : 'vendor'],
    queryFn: () =>
      api.request<Party[]>(
        `/api/tenant/parties?kind=${kind === 'work' ? 'subcontractor' : 'vendor'}`,
      ),
  });
  const [partyId, setPartyId] = useState('');
  const sites = p.sites.filter((s) => s.active);
  const { run, busy, error } = useRun(() => undefined);
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
      aria-label="New order"
      onSubmit={(e) => {
        e.preventDefault();
        void run('make', async () => {
          const o = await api.request<Order>(`/api/tenant/projects/${p.id}/orders`, {
            method: 'POST',
            body: { kind, partyId, siteId: sites.length === 1 ? sites[0]!.id : null, lines: [] },
          });
          onMade(o.id);
        });
      }}
    >
      <div className="w-40">
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as OrderKind);
              setPartyId('');
            }}
          >
            <option value="purchase">Purchase order</option>
            <option value="work">Work order</option>
          </Select>
        </Field>
      </div>
      <div className="min-w-64 flex-1">
        <Field label={kind === 'work' ? 'Subcontractor' : 'Vendor'}>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Choose</option>
            {vendors.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.gstin ? ` · ${v.gstin}` : ' · no GSTIN'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" busy={busy === 'make'} disabled={!partyId}>
        Write the order
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error && (
        <div className="w-full">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </form>
  );
}

interface OpenLine {
  requisitionId: string;
  number: string;
  title: string;
  position: number;
  description: string;
  unit: string;
  qty: string;
  neededBy: string | null;
}

/** An order to one supplier from approved requisition lines (docs/wave7-plan.md step 7c.4). */
function FromRequisitions({
  project: p,
  onCancel,
  onMade,
}: {
  project: ProjectDetail;
  onCancel: () => void;
  onMade: (id: string) => void;
}) {
  const open = useQuery({
    queryKey: ['requisition-lines', p.id],
    queryFn: () => api.request<OpenLine[]>(`/api/tenant/projects/${p.id}/requisition-lines`),
  });
  const vendors = useQuery({
    queryKey: ['parties', 'vendor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=vendor'),
  });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [partyId, setPartyId] = useState('');
  const [gstPct, setGstPct] = useState('18');
  const { run, busy, error } = useRun(() => undefined);
  const key = (l: OpenLine) => `${l.requisitionId}:${l.position}`;
  const toggle = (k: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return (
    <form
      aria-label="Order from requisitions"
      className="mb-4 space-y-3 rounded-md border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const lines = (open.data ?? [])
          .filter((l) => chosen.has(key(l)))
          .map((l) => ({ requisitionId: l.requisitionId, position: l.position }));
        void run('order', async () => {
          const o = await api.request<Order>(
            `/api/tenant/projects/${p.id}/orders/from-requisitions`,
            {
              method: 'POST',
              body: { partyId, gstPct, lines },
            },
          );
          onMade(o.id);
        });
      }}
    >
      {open.isPending ? (
        <Spinner />
      ) : !open.data?.length ? (
        <p className="text-sm text-fg-muted">
          No approved requisition line is waiting to be ordered.
        </p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Requisition lines">
          {open.data.map((l) => (
            <li key={key(l)}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.has(key(l))}
                  onChange={() => toggle(key(l))}
                />
                <span className="font-mono text-xs">{l.number}</span>
                <span>
                  {l.description}: {Number(l.qty).toLocaleString('en-IN')} {l.unit}
                </span>
                {l.neededBy ? <span className="text-xs text-fg-muted">by {l.neededBy}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Supplier">
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">Choose…</option>
            {(vendors.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GST %">
          <Select value={gstPct} onChange={(e) => setGstPct(e.target.value)}>
            {['0', '5', '12', '18', '28'].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </Select>
        </Field>
        <Button type="submit" busy={busy === 'order'} disabled={!partyId || chosen.size === 0}>
          Draft the order
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </form>
  );
}
