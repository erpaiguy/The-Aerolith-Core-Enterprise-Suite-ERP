// New drawing revisions sent to me by the distribution matrix, to acknowledge (docs/wave5-plan.md step 4); and the
// check behind the QR on a controlled copy, which needs no account and says only whether the print is current.
import { Alert, Badge, Button, Card, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { describeError } from '../../lib/format';

interface Receipt {
  id: string;
  number: string;
  title: string;
  revision: string;
  purpose: string;
  project: string;
  sentAt: string;
  acknowledgedAt: string | null;
  supersedes: string | null;
}

export function DrawingReceiptsScreen() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['drawing-receipts'],
    queryFn: () => api.request<Receipt[]>('/api/tenant/drawing-receipts'),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Drawing receipts"
        subtitle="New revisions sent to you: acknowledge once the old prints are withdrawn."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {q.isPending ? (
          <Spinner />
        ) : (q.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing sent to you.</p>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Drawing</th>
                <th>Revision</th>
                <th>Project</th>
                <th>Sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.map((r) => (
                <tr key={r.id} aria-label={`${r.number} rev ${r.revision}`}>
                  <td>
                    {r.number} {r.title}
                  </td>
                  <td>
                    {r.revision} for {r.purpose}
                    {r.supersedes && (
                      <span className="text-fg-muted"> (supersedes {r.supersedes})</span>
                    )}
                  </td>
                  <td>{r.project}</td>
                  <td>{new Date(r.sentAt).toLocaleDateString('en-IN')}</td>
                  <td>
                    {r.acknowledgedAt ? (
                      <Badge tone="success">Acknowledged</Badge>
                    ) : (
                      <Button
                        type="button"
                        onClick={async () => {
                          setError(null);
                          try {
                            qc.setQueryData(
                              ['drawing-receipts'],
                              await api.request<Receipt[]>(
                                `/api/tenant/drawing-receipts/${r.id}/acknowledge`,
                                { method: 'POST', body: {} },
                              ),
                            );
                            void qc.invalidateQueries({ queryKey: ['inbox'] });
                          } catch (err) {
                            setError(describeError(err));
                          }
                        }}
                      >
                        Acknowledge
                      </Button>
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

interface Check {
  project: string;
  number: string;
  title: string;
  revision: string;
  purpose: string;
  current: boolean;
  supersededOn: string | null;
  latest: { revision: string; purpose: string; receivedOn: string } | null;
}

export function CheckScreen({ tenant, code }: { tenant: string; code: string }) {
  const q = useQuery({
    queryKey: ['check', tenant, code],
    queryFn: () => api.request<Check>(`/api/check/${tenant}/${code}`, { auth: false }),
    retry: false,
  });
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm space-y-3 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-accent font-bold text-accent-fg">
          A
        </div>
        {q.isPending ? (
          <Spinner label="Checking" />
        ) : q.isError ? (
          <Alert tone="danger">{describeError(q.error)}</Alert>
        ) : (
          <div data-testid="check-result" className="space-y-2">
            <p className="text-sm text-fg-muted">{q.data.project}</p>
            <h1 className="text-lg font-semibold">
              {q.data.number} rev {q.data.revision}
            </h1>
            <p className="text-sm">{q.data.title}</p>
            {q.data.current ? (
              <p className="rounded-md bg-success/15 p-3 text-success">
                Current: this is the latest revision, for {q.data.purpose}.
              </p>
            ) : (
              <p className="rounded-md bg-danger/15 p-3 font-medium text-danger">
                Superseded on {q.data.supersededOn}. Do not use: the current revision is{' '}
                {q.data.latest?.revision} for {q.data.latest?.purpose}.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
