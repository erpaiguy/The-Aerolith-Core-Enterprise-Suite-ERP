// Deliveries across projects (docs/wave8-plan.md step 8e.2): what is overdue, with the last date the supplier
// promised, and the lead time from requisition to order to receipt, by supplier.
import { Alert, Card, EmptyState, Field, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { today } from '../accounts/model';
import { describeError } from '../lib/format';

interface Late {
  id: string;
  number: string;
  project: string;
  party: string;
  promisedOn: string | null;
  daysLate: number;
  late: { description: string; unit: string; dueOn: string; short: string }[];
}
interface LeadTimes {
  orders: {
    id: string;
    number: string;
    project: string;
    party: string;
    raised: string | null;
    approved: string | null;
    ordered: string;
    firstReceipt: string | null;
    toOrder: number | null;
    toDeliver: number | null;
    total: number | null;
  }[];
  bySupplier: {
    party: string;
    orders: number;
    toOrder: number | null;
    toDeliver: number | null;
    total: number | null;
  }[];
  average: {
    toApprove: number | null;
    toOrder: number | null;
    toDeliver: number | null;
    total: number | null;
  };
}
const days = (v: number | null) => (v === null ? '—' : `${v}`);
const fyStart = () => {
  const t = today();
  const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0);
  return `${y}-04-01`;
};

export function DeliveriesScreen() {
  const late = useQuery({
    queryKey: ['overdue-deliveries'],
    queryFn: () => api.request<Late[]>('/api/tenant/procurement/overdue-deliveries'),
  });
  const [range, setRange] = useState({ from: fyStart(), to: today() });
  const lt = useQuery({
    queryKey: ['lead-times', range],
    queryFn: () =>
      api.request<LeadTimes>(
        `/api/tenant/procurement/lead-times?from=${range.from}&to=${range.to}`,
      ),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Delivery follow-up"
        subtitle="Deliveries overdue, and how long buying takes from requisition to receipt."
      />
      <Card title="Overdue deliveries">
        {late.isPending ? (
          <Spinner />
        ) : late.isError ? (
          <Alert tone="danger">{describeError(late.error)}</Alert>
        ) : late.data.length === 0 ? (
          <EmptyState title="Nothing overdue.">
            Orders whose delivery date has passed with goods still to come appear here.
          </EmptyState>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Order</th>
                <th>Supplier</th>
                <th>What is short</th>
                <th className="text-right">Days late</th>
                <th>Promised</th>
              </tr>
            </thead>
            <tbody aria-label="Overdue deliveries">
              {late.data.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to="/orders/$orderId" params={{ orderId: o.id }} className="underline">
                      {o.number}
                    </Link>
                    <div className="text-xs text-fg-muted">{o.project}</div>
                  </td>
                  <td>{o.party}</td>
                  <td className="text-sm">
                    {o.late.map((x, k) => (
                      <div key={k}>
                        {x.description}: {Number(x.short).toLocaleString('en-IN')} {x.unit} due{' '}
                        {x.dueOn}
                      </div>
                    ))}
                  </td>
                  <td className="text-right tabular-nums">{o.daysLate}</td>
                  <td>{o.promisedOn ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Lead times (days)">
        <div className="mb-3 flex flex-wrap gap-3">
          <Field label="Ordered from">
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          </Field>
          <Field label="to">
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          </Field>
        </div>
        {lt.data && (
          <>
            <p className="mb-2 text-sm">
              On average: requisition to approval {days(lt.data.average.toApprove)}, to order{' '}
              {days(lt.data.average.toOrder)}, order to first delivery{' '}
              {days(lt.data.average.toDeliver)}; requisition to delivery{' '}
              {days(lt.data.average.total)}.
            </p>
            {lt.data.bySupplier.length > 0 && (
              <Table minWidth="36rem">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th className="text-right">Orders</th>
                    <th className="text-right">To order</th>
                    <th className="text-right">To deliver</th>
                    <th className="text-right">Requisition to delivery</th>
                  </tr>
                </thead>
                <tbody aria-label="Lead times by supplier">
                  {lt.data.bySupplier.map((s) => (
                    <tr key={s.party}>
                      <td>{s.party}</td>
                      <td className="text-right">{s.orders}</td>
                      <td className="text-right">{days(s.toOrder)}</td>
                      <td className="text-right">{days(s.toDeliver)}</td>
                      <td className="text-right">{days(s.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
