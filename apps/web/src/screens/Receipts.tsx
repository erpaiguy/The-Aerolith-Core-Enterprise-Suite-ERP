// Goods receipts across the projects I am on (docs/wave2b-plan.md step 5). New ones are recorded from a purchase
// order's page.
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
import { day, useGridStorage } from '../lib/grid';
import type { ReceiptRow } from '../procurement/orders';
import { shortDate } from '../schedule/model';

const status = (r: ReceiptRow) =>
  r.status === 'cancelled' ? 'Cancelled' : r.held > 0 ? `${r.held} held` : 'Received';

const columns: GridColumn<ReceiptRow>[] = [
  {
    id: 'receipt',
    header: 'Receipt',
    width: 280,
    hideable: false,
    value: (r) => r.number,
    cell: (r) => (
      <>
        <Link
          to="/receipts/$receiptId"
          params={{ receiptId: r.id }}
          className="font-mono text-sm text-accent hover:underline"
        >
          {r.number}
        </Link>
        <span className="block text-xs text-fg-muted">
          {r.orderNumber} · {r.vendor} · challan {r.challanNo}
        </span>
      </>
    ),
  },
  {
    id: 'project',
    header: 'Project',
    width: 220,
    value: (r) => `${r.project.number} · ${r.project.name}`,
    cell: (r) => (
      <span className="text-sm">
        {r.project.number} · {r.project.name}
      </span>
    ),
  },
  {
    id: 'receivedOn',
    header: 'Received',
    width: 120,
    value: (r) => day(r.receivedOn),
    cell: (r) => <span className="whitespace-nowrap tabular-nums">{shortDate(r.receivedOn)}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    width: 130,
    value: status,
    cell: (r) =>
      r.status === 'cancelled' ? (
        <Badge>Cancelled</Badge>
      ) : r.held > 0 ? (
        <Badge tone="warning">{r.held} held</Badge>
      ) : (
        <Badge tone="success">Received</Badge>
      ),
  },
];

export function ReceiptsScreen() {
  const [show, setShow] = useState('');
  const rows = useQuery({
    queryKey: ['receipts', 'all', show],
    queryFn: () => api.request<ReceiptRow[]>(`/api/tenant/receipts${show ? `?held=true` : ''}`),
  });
  const storage = useGridStorage('receipts');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Goods receipts"
        subtitle="What came against the purchase orders of the projects you are on. Record one from the order's page."
      />
      <div className="w-56">
        <Field label="Show">
          <Select value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="">All</option>
            <option value="held">Waiting for inspection</option>
          </Select>
        </Field>
      </div>
      <Card>
        {rows.isPending ? (
          <Spinner />
        ) : rows.isError ? (
          <Alert tone="danger">{describeError(rows.error)}</Alert>
        ) : (
          <DataGrid
            id="receipts"
            label="Goods receipts"
            columns={columns}
            rows={rows.data}
            rowKey={(r) => r.id}
            storage={storage}
            exportName="Goods receipts"
            empty={
              <EmptyState title="No goods receipts.">
                A store records a receipt against an order when the goods arrive.
              </EmptyState>
            }
          />
        )}
      </Card>
    </div>
  );
}
