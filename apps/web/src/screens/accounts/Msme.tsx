// MSME suppliers (docs/wave8-plan.md step 8b.4): bills of micro and small enterprises past or nearing 45 days, the
// year-end section 43B(h) disallowance, and the half-yearly MSME-1 data.
import { Alert, Badge, Card, EmptyState, Field, Input, Select, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../api/client';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';

interface MsmeBill {
  billId: string;
  billNo: string;
  billDate: string;
  party: string;
  msmeType: string;
  limitDate: string;
  outstanding: string;
}

export function MsmeCard({ entityId, asOf }: { entityId: string; asOf: string }) {
  const fy =
    Number(asOf.slice(5, 7)) >= 4 ? Number(asOf.slice(0, 4)) : Number(asOf.slice(0, 4)) - 1;
  const [view, setView] = useState<'alerts' | '43bh' | 'msme1'>('alerts');
  const [year, setYear] = useState(String(fy));
  const [half, setHalf] = useState(
    `${fy}-H${Number(asOf.slice(5, 7)) >= 4 && Number(asOf.slice(5, 7)) <= 9 ? 1 : 2}`,
  );
  const alerts = useQuery({
    queryKey: ['msme-alerts', entityId, asOf],
    queryFn: () =>
      api.request<{ overdue: MsmeBill[]; dueSoon: MsmeBill[] }>(
        `/api/tenant/accounts/msme/alerts?entityId=${entityId}&asOf=${asOf}`,
      ),
  });
  const h = useQuery({
    queryKey: ['msme-43bh', entityId, year],
    queryFn: () =>
      api.request<{ rows: (MsmeBill & { disallowed: string })[]; total: string }>(
        `/api/tenant/accounts/msme/43bh?entityId=${entityId}&year=${year}`,
      ),
    enabled: view === '43bh',
  });
  const m1 = useQuery({
    queryKey: ['msme-1', entityId, half],
    queryFn: () =>
      api.request<{
        asOf: string;
        suppliers: {
          party: string;
          pan: string | null;
          udyamNo: string | null;
          amount: string;
          since: string;
          bills: number;
        }[];
        total: string;
        missingUdyam: string[];
      }>(`/api/tenant/accounts/msme/msme-1?entityId=${entityId}&half=${half}`),
    enabled: view === 'msme1',
  });
  if (alerts.isError) return <Alert tone="danger">{describeError(alerts.error)}</Alert>;
  const rows = alerts.data
    ? [
        ...alerts.data.overdue.map((b) => ({ ...b, late: true })),
        ...alerts.data.dueSoon.map((b) => ({ ...b, late: false })),
      ]
    : [];
  return (
    <Card
      title="MSME suppliers: the 45 days"
      actions={
        <Select
          aria-label="View"
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
        >
          <option value="alerts">Due and overdue</option>
          <option value="43bh">Section 43B(h) at the year end</option>
          <option value="msme1">MSME-1 half year</option>
        </Select>
      }
    >
      {view === 'alerts' &&
        (rows.length === 0 ? (
          <EmptyState title="No micro or small supplier's bill is near its 45 days." />
        ) : (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>Supplier and bill</th>
                <th>Pay by</th>
                <th className="text-right">Unpaid</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="MSME bills">
              {rows.map((b) => (
                <tr key={b.billId}>
                  <td>
                    {b.party}{' '}
                    <Link
                      to="/accounts/vendor-bills/$billId"
                      params={{ billId: b.billId }}
                      className="text-xs hover:underline"
                    >
                      {b.billNo}
                    </Link>
                  </td>
                  <td>{shortDate(b.limitDate)}</td>
                  <td className="text-right tabular-nums">{rupees(b.outstanding)}</td>
                  <td>
                    <Badge tone={b.late ? 'danger' : 'warning'}>
                      {b.late ? 'Past 45 days' : 'This week'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      {view === '43bh' && (
        <>
          <Field label="Financial year from April">
            <Input
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-28"
              inputMode="numeric"
            />
          </Field>
          {h.isError ? (
            <Alert tone="danger">{describeError(h.error)}</Alert>
          ) : h.data ? (
            <>
              <p className="my-2 text-sm">
                Disallowed under section 43B(h) until paid: <strong>{rupees(h.data.total)}</strong>
              </p>
              <Table minWidth="32rem">
                <thead>
                  <tr>
                    <th>Supplier and bill</th>
                    <th>Pay by</th>
                    <th className="text-right">Disallowed</th>
                  </tr>
                </thead>
                <tbody aria-label="43B(h)">
                  {h.data.rows.map((r) => (
                    <tr key={r.billId}>
                      <td>
                        {r.party} <span className="text-xs text-fg-muted">{r.billNo}</span>
                      </td>
                      <td>{shortDate(r.limitDate)}</td>
                      <td className="text-right tabular-nums">{rupees(r.disallowed)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : null}
        </>
      )}
      {view === 'msme1' && (
        <>
          <Field label="Half year">
            <Select value={half} onChange={(e) => setHalf(e.target.value)} className="w-56">
              {[fy, fy - 1].flatMap((y) => [
                <option key={`${y}-H1`} value={`${y}-H1`}>
                  April to September {y}
                </option>,
                <option key={`${y}-H2`} value={`${y}-H2`}>
                  October {y} to March {y + 1}
                </option>,
              ])}
            </Select>
          </Field>
          {m1.isError ? (
            <Alert tone="danger">{describeError(m1.error)}</Alert>
          ) : m1.data ? (
            <>
              {m1.data.missingUdyam.length ? (
                <Alert tone="warning">No Udyam number for {m1.data.missingUdyam.join(', ')}.</Alert>
              ) : null}
              <Table minWidth="36rem">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>PAN</th>
                    <th>Udyam</th>
                    <th className="text-right">Owed beyond 45 days</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody aria-label="MSME-1">
                  {m1.data.suppliers.map((s) => (
                    <tr key={s.party}>
                      <td>{s.party}</td>
                      <td>{s.pan ?? '—'}</td>
                      <td>{s.udyamNo ?? '—'}</td>
                      <td className="text-right tabular-nums">{rupees(s.amount)}</td>
                      <td>{shortDate(s.since)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}
