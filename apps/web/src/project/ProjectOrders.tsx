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
  return (
    <Card
      title={`Orders${orders.data ? ` (${orders.data.length})` : ''}`}
      actions={
        mayStart &&
        !starting && (
          <Button variant="secondary" onClick={() => setStarting(true)}>
            <Plus className="size-4" aria-hidden /> New order
          </Button>
        )
      }
    >
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
