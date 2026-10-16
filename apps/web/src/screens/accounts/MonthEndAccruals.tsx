// Material at site and month-end accruals (docs/wave8-plan.md step 8a.2): per project, goods received but not yet
// invoiced, subcontract work measured but not yet billed, and the stock in its stores; posted as one journal on the
// month's last day and reversed on the next month's first.
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { CompanyPicker } from './Vouchers';

interface Accruals {
  month: string;
  asOf: string;
  rows: {
    project: { id: string; number: string; name: string };
    goodsNotInvoiced: string;
    workNotBilled: string;
    siteStock: string;
    orders: { number: string; kind: 'purchase' | 'work'; amount: string }[];
    posted: { voucher: string | null; reversal: string | null } | null;
  }[];
  totals: { goodsNotInvoiced: string; workNotBilled: string; siteStock: string };
  closingStockPosted: boolean;
  posted: boolean;
  mayPost: boolean;
}
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const right = 'text-right';

export function MonthEndAccrualsScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const [month, setMonth] = useState(lastMonth());
  const [error, setError] = useState<string | null>(null);
  const key = ['month-end-accruals', company?.id, month];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Accruals>(
        `/api/tenant/accounts/month-end-accruals?entityId=${company!.id}&month=${month}`,
      ),
    enabled: !!company && /^\d{4}-\d{2}$/.test(month),
  });
  const post = async () => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Accruals>('/api/tenant/accounts/month-end-accruals', {
          method: 'POST',
          body: { entityId: company!.id, month },
        }),
      );
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Month-end accruals"
        subtitle="Costs incurred but not yet billed, and stock lying at site, for the month's books."
        actions={
          <div className="flex flex-wrap gap-2">
            {company ? <CompanyPicker value={company.id} onChange={choose} /> : null}
            <Input
              type="month"
              aria-label="Month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
        }
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <Card
          title={
            <span className="flex items-center gap-2">
              As at {q.data.asOf}
              {q.data.posted ? <Badge tone="success">Posted</Badge> : null}
            </span>
          }
        >
          {q.data.closingStockPosted ? (
            <Alert tone="info">
              The year-end closing stock is posted on this day, so stock at site is left out here.
            </Alert>
          ) : null}
          {q.data.rows.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Nothing received or measured unbilled, and no stock at site.
            </p>
          ) : (
            <Table minWidth="48rem">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className={right}>Received, not invoiced</th>
                  <th className={right}>Measured, not billed</th>
                  <th className={right}>Stock at site</th>
                </tr>
              </thead>
              <tbody aria-label="Accruals">
                {q.data.rows.map((r) => (
                  <tr key={r.project.id}>
                    <td>
                      <span className="font-mono text-xs">{r.project.number}</span> {r.project.name}
                      {r.orders.length ? (
                        <div className="text-xs text-fg-muted">
                          {r.orders.map((o) => `${o.number} ${formatInr(o.amount)}`).join(' · ')}
                        </div>
                      ) : null}
                      {r.posted?.voucher ? (
                        <div className="text-xs text-fg-muted">
                          {r.posted.voucher}, reversed by {r.posted.reversal}
                        </div>
                      ) : null}
                    </td>
                    <td className={right}>{formatInr(r.goodsNotInvoiced)}</td>
                    <td className={right}>{formatInr(r.workNotBilled)}</td>
                    <td className={right}>{formatInr(r.siteStock)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td>Total</td>
                  <td className={right}>{formatInr(q.data.totals.goodsNotInvoiced)}</td>
                  <td className={right}>{formatInr(q.data.totals.workNotBilled)}</td>
                  <td className={right}>{formatInr(q.data.totals.siteStock)}</td>
                </tr>
              </tfoot>
            </Table>
          )}
          <p className="mt-2 text-xs text-fg-muted">
            Received goods are valued at the order's rate, measured work at the work order's rate,
            and site stock at its stock-ledger value. Post these before revenue on work done, which
            uses the month's cost.
          </p>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!q.data.posted && q.data.mayPost && q.data.rows.length ? (
            <div className="mt-3">
              <Button onClick={() => void post()}>Post the month</Button>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
