// Stock ageing (docs/wave8-plan.md step 8e.4): what lies in the stores by how long it has lain, and what has not been
// issued for three months: money tied up on the shelf.
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import { numberLocale } from '../lib/locale';

const BUCKETS = ['0-30', '31-90', '91-180', 'over 180'] as const;
interface Ageing {
  asOn: string;
  slowAfterDays: number;
  rows: {
    storeId: string;
    store: string;
    project: string;
    code: string;
    name: string;
    unit: string;
    qty: string;
    value: string;
    oldestDays: number;
    idleDays: number;
    lastIssue: string | null;
    slow: boolean;
    buckets: Record<(typeof BUCKETS)[number], string>;
  }[];
  totals: Record<(typeof BUCKETS)[number], string>;
  slowValue: string;
}

export function StockAgeingScreen() {
  const q = useQuery({
    queryKey: ['stock-ageing'],
    queryFn: () => api.request<Ageing>('/api/tenant/procurement/stock-ageing'),
  });
  const [slowOnly, setSlowOnly] = useState(false);
  const d = q.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock ageing"
        subtitle="Stock by how long it has lain (oldest issued first), and what has not moved."
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-5">
            {BUCKETS.map((b) => (
              <Card key={b}>
                <div className="text-xs text-fg-muted">{b} days</div>
                <div className="text-lg font-semibold tabular-nums">{rupees(d!.totals[b])}</div>
              </Card>
            ))}
            <Card>
              <div className="text-xs text-fg-muted">Not issued in {d!.slowAfterDays} days</div>
              <div className="text-lg font-semibold tabular-nums text-danger">
                {rupees(d!.slowValue)}
              </div>
            </Card>
          </div>
          <Card
            title="By store and material"
            actions={
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={slowOnly}
                  onChange={(e) => setSlowOnly(e.target.checked)}
                />
                Slow-moving only
              </label>
            }
          >
            {d!.rows.length === 0 ? (
              <EmptyState title="The stores are empty.">
                Stock shows here once goods are received into a store.
              </EmptyState>
            ) : (
              <Table minWidth="56rem">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Material</th>
                    <th className="text-right">In stock</th>
                    {BUCKETS.map((b) => (
                      <th key={b} className="text-right">
                        {b} days
                      </th>
                    ))}
                    <th>Last issued</th>
                  </tr>
                </thead>
                <tbody aria-label="Stock ageing">
                  {d!.rows
                    .filter((r) => !slowOnly || r.slow)
                    .map((r) => (
                      <tr key={`${r.storeId}-${r.code}`}>
                        <td>
                          <Link
                            to="/stores/$storeId"
                            params={{ storeId: r.storeId }}
                            className="underline"
                          >
                            {r.store}
                          </Link>
                          <div className="text-xs text-fg-muted">{r.project}</div>
                        </td>
                        <td>
                          <span className="mr-2 font-mono text-xs">{r.code}</span>
                          {r.name}
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          {Number(r.qty).toLocaleString(numberLocale())} {r.unit}
                          <div className="text-xs text-fg-muted">{rupees(r.value)}</div>
                        </td>
                        {BUCKETS.map((b) => (
                          <td key={b} className="text-right tabular-nums">
                            {Number(r.buckets[b]) ? rupees(r.buckets[b]) : ''}
                          </td>
                        ))}
                        <td>
                          {r.lastIssue ?? 'never'}
                          {r.slow && (
                            <>
                              {' '}
                              <Badge tone="warning">slow</Badge>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
