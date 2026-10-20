// Purchase and work orders across the projects I am on (docs/wave2b-plan.md step 4). New ones are written from a
// project's page, or made from the vendors chosen in its enquiry.
import {
  Alert,
  Badge,
  Card,
  DataGrid,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Spinner,
  type GridColumn,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { day, num, useGridStorage } from '../lib/grid';
import { rupees } from '../procurement/OrderLines';
import {
  ORDER_KIND,
  ORDER_STATUS,
  ORDER_TONE,
  REVISION_STATUS,
  type OrderRow,
} from '../procurement/orders';
import { shortDate } from '../schedule/model';

export function OrdersScreen() {
  const [status, setStatus] = useState('open');
  const rows = useQuery({
    queryKey: ['orders', 'all', status],
    queryFn: () =>
      api.request<OrderRow[]>(`/api/tenant/orders${status ? `?status=${status}` : ''}`),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        subtitle="Purchase and work orders of the projects you are on. Write one from a project's page, or from the vendors chosen in its enquiry."
      />
      <div className="w-56">
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open (draft, issued, acknowledged)</option>
            <option value="draft">Draft</option>
            <option value="issued">Issued, not yet acknowledged</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Cancelled</option>
            <option value="">All</option>
          </Select>
        </Field>
      </div>
      <Card>
        {rows.isPending ? (
          <Spinner />
        ) : rows.isError ? (
          <Alert tone="danger">{describeError(rows.error)}</Alert>
        ) : (
          <OrderTable rows={rows.data} showProject />
        )}
      </Card>
    </div>
  );
}

export function OrderTable({
  rows,
  showProject = false,
}: {
  rows: OrderRow[];
  showProject?: boolean;
}) {
  // The company-wide list and a project's own list keep separate layouts: the project column is only on the first.
  const id = showProject ? 'orders' : 'project-orders';
  const storage = useGridStorage(id);
  const columns: GridColumn<OrderRow>[] = [
    {
      id: 'order',
      header: 'Order',
      width: 220,
      hideable: false,
      value: (o) => o.number,
      cell: (o) => (
        <>
          <Link
            to="/orders/$orderId"
            params={{ orderId: o.id }}
            className="font-mono text-sm text-accent hover:underline"
          >
            {o.number}
          </Link>
          <span className="block text-xs text-fg-muted">
            {ORDER_KIND[o.kind]} · {o.vendor}
          </span>
        </>
      ),
    },
    ...(showProject
      ? [
          {
            id: 'project',
            header: 'Project',
            width: 220,
            value: (o: OrderRow) => `${o.project.number} · ${o.project.name}`,
            cell: (o: OrderRow) => (
              <span className="text-sm">
                {o.project.number} · {o.project.name}
              </span>
            ),
          },
        ]
      : []),
    {
      id: 'total',
      header: 'With GST',
      align: 'right',
      width: 130,
      value: (o) => num(o.total),
      cell: (o) => rupees(o.total),
    },
    {
      id: 'deliverBy',
      header: 'Deliver by',
      width: 120,
      value: (o) => day(o.deliverBy),
      cell: (o) => <span className="whitespace-nowrap tabular-nums">{shortDate(o.deliverBy)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 200,
      value: (o) => ORDER_STATUS[o.status],
      cell: (o) => (
        <>
          <Badge tone={ORDER_TONE[o.status]}>{ORDER_STATUS[o.status]}</Badge>
          {o.openStatus && o.status !== 'draft' && (
            <span className="block text-xs text-fg-muted">
              Amendment {o.openRevision}: {REVISION_STATUS[o.openStatus].toLowerCase()}
            </span>
          )}
          {o.openStatus && o.status === 'draft' && o.openStatus !== 'draft' && (
            <span className="block text-xs text-fg-muted">{REVISION_STATUS[o.openStatus]}</span>
          )}
        </>
      ),
    },
  ];
  return (
    <DataGrid
      id={id}
      label="Orders"
      columns={columns}
      rows={rows}
      rowKey={(o) => o.id}
      storage={storage}
      exportName="Orders"
      empty={
        <EmptyState title="No orders.">
          Write one from a project's page, or from the vendors chosen in its enquiry.
        </EmptyState>
      }
    />
  );
}
