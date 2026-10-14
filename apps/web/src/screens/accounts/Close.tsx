// Month-end close (docs/wave7-plan.md step 7c.6): a company's month, each close step's state as the books show it,
// and the lock once every step is done.
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, MinusCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { useCompany } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { CompanyPicker } from './Vouchers';

interface Close {
  steps: { key: string; label: string; state: 'done' | 'open' | 'na'; detail: string }[];
  ready: boolean;
  locked: boolean;
  mayLock: boolean;
}
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

export function CloseScreen() {
  const qc = useQueryClient();
  const { company, choose } = useCompany();
  const [month, setMonth] = useState(lastMonth());
  const [error, setError] = useState<string | null>(null);
  const key = ['close', company?.id, month];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Close>(`/api/tenant/accounts/close?entityId=${company!.id}&month=${month}`),
    enabled: !!company && /^\d{4}-\d{2}$/.test(month),
  });
  const lock = async () => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Close>('/api/tenant/accounts/close/lock', {
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
        title="Month-end close"
        subtitle="Each step as the books show it. When all are done, the month can be locked."
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
              Close of {month}
              {q.data.locked ? <Badge tone="success">Locked</Badge> : null}
            </span>
          }
        >
          <ul className="divide-y divide-line" aria-label="Close steps">
            {q.data.steps.map((s) => (
              <li key={s.key} className="flex items-start gap-3 py-2" data-state={s.state}>
                {s.state === 'done' ? (
                  <CheckCircle2 className="mt-0.5 size-5 text-success" aria-label="Done" />
                ) : s.state === 'na' ? (
                  <MinusCircle
                    className="mt-0.5 size-5 text-fg-subtle"
                    aria-label="Does not apply"
                  />
                ) : (
                  <Circle className="mt-0.5 size-5 text-warning" aria-label="Open" />
                )}
                <div>
                  <div className="font-medium">{s.label}</div>
                  <div className="text-sm text-fg-muted">{s.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!q.data.locked && q.data.mayLock ? (
            <div className="mt-3">
              <Button onClick={() => void lock()} disabled={!q.data.ready}>
                Lock the month
              </Button>
              {!q.data.ready ? (
                <span className="ml-3 text-sm text-fg-muted">Finish the open steps first.</span>
              ) : null}
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
