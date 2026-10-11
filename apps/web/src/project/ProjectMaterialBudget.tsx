// A project's material budget on its page (docs/wave2b-plan.md step 2): the revision in force, the one being worked
// on, the revisions before; making it from the tender (or empty) and starting a revision.
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { useRun } from '../approvals/model';
import { describeError, formatDate, formatInr } from '../lib/format';
import { BUDGET_STATUS, BUDGET_TONE, type BudgetStatus } from '../screens/MaterialBudget';

interface Overview {
  inForce: Revision | null;
  open: Revision | null;
  revisions: Revision[];
  mayKeep: boolean;
  mayStart: boolean;
  fromTender: boolean;
}
interface Revision {
  id: string;
  revision: number;
  status: BudgetStatus;
  reason: string;
  total: string;
  createdAt: string;
  approvedAt: string | null;
  lines: number;
}

export function ProjectMaterialBudget({ project: p }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const o = useQuery({
    queryKey: ['material-budget-overview', p.id],
    queryFn: () => api.request<Overview>(`/api/tenant/projects/${p.id}/material-budget`),
  });
  const { run, busy, error } = useRun(
    () => void qc.invalidateQueries({ queryKey: ['material-budget-overview', p.id] }),
  );
  const [reason, setReason] = useState<string | null>(null);
  const open = (id: string) =>
    navigate({ to: '/material-budgets/$budgetId', params: { budgetId: id } });
  const make = (path: string, body: object = {}) =>
    void run(path, async () => {
      const b = await api.request<{ id: string }>(
        `/api/tenant/projects/${p.id}/material-budget/${path}`,
        {
          method: 'POST',
          body,
        },
      );
      await open(b.id);
    });
  if (o.isPending) return <Spinner />;
  if (o.isError) return <Alert tone="danger">{describeError(o.error)}</Alert>;
  const d = o.data;
  return (
    <Card title="Material budget">
      {d.revisions.length === 0 ? (
        <div className="space-y-3 text-sm">
          <p className="text-fg-muted">
            {d.fromTender
              ? "None yet. Made from the tender's rate analyses: what each BOQ item takes of cement, steel, labour and the rest, at the estimate's rates. The tender's estimate is then closed."
              : 'None yet. This project has no contract BOQ from a tender here: start an empty budget and add to it.'}
          </p>
          {d.mayStart && (
            <div className="flex gap-2">
              {d.fromTender && (
                <Button busy={busy === 'from-tender'} onClick={() => make('from-tender')}>
                  Make it from the tender
                </Button>
              )}
              <Button variant="secondary" busy={busy === 'blank'} onClick={() => make('blank')}>
                Start an empty budget
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {d.inForce ? (
            <p data-testid="budget-in-force">
              In force:{' '}
              <Link
                to="/material-budgets/$budgetId"
                params={{ budgetId: d.inForce.id }}
                className="text-accent hover:underline"
              >
                revision {d.inForce.revision}
              </Link>
              , {formatInr(d.inForce.total)} for {d.inForce.lines} resource
              {d.inForce.lines === 1 ? '' : 's'}
              {d.inForce.approvedAt && `, since ${formatDate(d.inForce.approvedAt)}`}.
            </p>
          ) : (
            <p className="text-fg-muted">No revision is in force yet.</p>
          )}
          {d.open && (
            <p>
              <Link
                to="/material-budgets/$budgetId"
                params={{ budgetId: d.open.id }}
                className="text-accent hover:underline"
              >
                Revision {d.open.revision}
              </Link>{' '}
              <Badge tone={BUDGET_TONE[d.open.status]}>{BUDGET_STATUS[d.open.status]}</Badge>
            </p>
          )}
          {d.mayKeep && d.inForce && !d.open && reason === null && (
            <Button variant="secondary" onClick={() => setReason('')}>
              Start a revision
            </Button>
          )}
          {reason !== null && (
            <form
              className="flex flex-wrap items-end gap-2"
              aria-label="New revision"
              onSubmit={(e) => {
                e.preventDefault();
                make('revise', { reason: reason.trim() });
              }}
            >
              <div className="min-w-64 flex-1">
                <Field label="Why revise it?">
                  <Input
                    value={reason}
                    maxLength={2000}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
              </div>
              <Button type="submit" busy={busy === 'revise'} disabled={reason.trim().length < 3}>
                Start
              </Button>
              <Button type="button" variant="ghost" onClick={() => setReason(null)}>
                Cancel
              </Button>
            </form>
          )}
          {d.revisions.length > 1 && (
            <details>
              <summary className="cursor-pointer text-fg-muted">
                All revisions ({d.revisions.length})
              </summary>
              <ul className="mt-2 space-y-1" aria-label="Budget revisions">
                {d.revisions.map((r) => (
                  <li key={r.id}>
                    <Link
                      to="/material-budgets/$budgetId"
                      params={{ budgetId: r.id }}
                      className="text-accent hover:underline"
                    >
                      Revision {r.revision}
                    </Link>{' '}
                    <Badge tone={BUDGET_TONE[r.status]}>{BUDGET_STATUS[r.status]}</Badge>{' '}
                    {formatInr(r.total)}
                    {r.reason && <span className="text-fg-muted"> · {r.reason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
