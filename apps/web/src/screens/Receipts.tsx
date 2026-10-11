// Goods receipts across the projects I am on (docs/wave2b-plan.md step 5). New ones are recorded from a purchase
// order's page.
import { Alert, Badge, Card, Field, PageHeader, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import type { ReceiptRow } from '../procurement/orders';
import { shortDate } from '../schedule/model';

export function ReceiptsScreen() {
  const [show, setShow] = useState('');
  const rows = useQuery({
    queryKey: ['receipts', 'all', show],
    queryFn: () => api.request<ReceiptRow[]>(`/api/tenant/receipts${show ? `?held=true` : ''}`),
  });
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
        ) : rows.data.length === 0 ? (
          <p className="text-sm text-fg-muted">None.</p>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Project</th>
                <th>Received</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody aria-label="Goods receipts">
              {rows.data.map((r) => (
                <tr key={r.id}>
                  <td>
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
                  </td>
                  <td className="text-sm">
                    {r.project.number} · {r.project.name}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{shortDate(r.receivedOn)}</td>
                  <td>
                    {r.status === 'cancelled' ? (
                      <Badge>Cancelled</Badge>
                    ) : r.held > 0 ? (
                      <Badge tone="warning">{r.held} held</Badge>
                    ) : (
                      <Badge tone="success">Received</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
