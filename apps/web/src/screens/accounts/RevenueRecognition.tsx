// Revenue on work done (docs/wave8-plan.md step 8a.1, Ind AS 115): for a company and a month, each project's share
// complete, the revenue it has earned, what its bills have taken, and the difference — unbilled revenue or billing
// in excess — with any expected loss; posted as one journal on the month's last day, reversed on the next month's
// first.
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { useCompany } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { CompanyPicker } from './Vouchers';

interface Row {
  project: { id: string; number: string; name: string };
  method: 'cost' | 'measured';
  contractValue: string;
  estimatedCost: string;
  costToDate: string;
  measuredValue: string;
  pctComplete: number;
  recognised: string;
  billed: string;
  adjustment: string;
  lossProvision: string;
  margin: string;
  posted: { voucher: string | null; reversal: string | null } | null;
}
interface Month {
  month: string;
  asOf: string;
  rows: Row[];
  totals: {
    recognised: string;
    billed: string;
    adjustment: string;
    lossProvision: string;
    costToDate: string;
  };
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

export function RevenueRecognitionScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const [month, setMonth] = useState(lastMonth());
  const [error, setError] = useState<string | null>(null);
  const key = ['revenue-recognition', company?.id, month];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Month>(
        `/api/tenant/accounts/revenue-recognition?entityId=${company!.id}&month=${month}`,
      ),
    enabled: !!company && /^\d{4}-\d{2}$/.test(month),
  });
  const post = async () => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Month>('/api/tenant/accounts/revenue-recognition', {
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
        title="Revenue on work done"
        subtitle="Ind AS 115: revenue each project has earned by the month's end, against what its bills took."
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
          {q.data.rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No project with work or bills by then.</p>
          ) : (
            <Table minWidth="64rem">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className={right}>Contract</th>
                  <th className={right}>Estimated cost</th>
                  <th className={right}>Cost to date</th>
                  <th className={right}>Complete</th>
                  <th className={right}>Earned</th>
                  <th className={right}>Billed</th>
                  <th className={right}>Unbilled / (in excess)</th>
                  <th className={right}>Loss provision</th>
                  <th className={right}>Margin</th>
                </tr>
              </thead>
              <tbody aria-label="Work done">
                {q.data.rows.map((r) => (
                  <tr key={r.project.id}>
                    <td>
                      <span className="font-mono text-xs">{r.project.number}</span> {r.project.name}
                      {r.posted?.voucher ? (
                        <div className="text-xs text-fg-muted">
                          {r.posted.voucher}, reversed by {r.posted.reversal}
                        </div>
                      ) : null}
                    </td>
                    <td className={right}>{formatInr(r.contractValue)}</td>
                    <td className={right}>
                      {r.method === 'cost' ? formatInr(r.estimatedCost) : '—'}
                    </td>
                    <td className={right}>{formatInr(r.costToDate)}</td>
                    <td className={right}>
                      {(r.pctComplete * 100).toFixed(1)}%
                      <div className="text-xs text-fg-muted">
                        by {r.method === 'cost' ? 'cost' : 'measured value'}
                      </div>
                    </td>
                    <td className={right}>{formatInr(r.recognised)}</td>
                    <td className={right}>{formatInr(r.billed)}</td>
                    <td className={`${right} ${Number(r.adjustment) < 0 ? 'text-warning' : ''}`}>
                      {formatInr(r.adjustment)}
                    </td>
                    <td className={right}>
                      {Number(r.lossProvision) ? formatInr(r.lossProvision) : '—'}
                    </td>
                    <td className={`${right} ${Number(r.margin) < 0 ? 'text-danger' : ''}`}>
                      {formatInr(r.margin)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td>Total</td>
                  <td />
                  <td />
                  <td className={right}>{formatInr(q.data.totals.costToDate)}</td>
                  <td />
                  <td className={right}>{formatInr(q.data.totals.recognised)}</td>
                  <td className={right}>{formatInr(q.data.totals.billed)}</td>
                  <td className={right}>{formatInr(q.data.totals.adjustment)}</td>
                  <td className={right}>{formatInr(q.data.totals.lossProvision)}</td>
                  <td />
                </tr>
              </tfoot>
            </Table>
          )}
          <p className="mt-2 text-xs text-fg-muted">
            Share complete is cost to date over the estimated total cost from cost control; a
            project with no cost estimate uses the value measured at contract rates. The journal is
            dated the month's last day and reversed on the next month's first.
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
