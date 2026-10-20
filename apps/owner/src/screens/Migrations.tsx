import { Alert, Badge, Button, Card, EmptyState, Spinner, useConfirm } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { api, type MigrationRun } from '../api';
import { errorMessage, formatDateTime } from '../format';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { PageHeader, Table } from './Shell';

interface RolloutSummary {
  targetVersion: string;
  status: 'completed' | 'paused';
  counts: Record<string, number>;
}

const RESULT_TONE: Record<string, 'success' | 'neutral' | 'danger' | 'warning'> = {
  applied: 'success',
  up_to_date: 'neutral',
  failed: 'danger',
  unreachable: 'warning',
  not_attempted: 'warning',
};

function Results({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return <span className="text-fg-muted">no tenants</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {entries.map(([k, n]) => (
        <Badge key={k} tone={RESULT_TONE[k] ?? 'neutral'}>
          {k.replaceAll('_', ' ')} {n}
        </Badge>
      ))}
    </span>
  );
}

/** Tenant database schema rollouts (docs/tenant-provisioning.md). */
export function MigrationsScreen() {
  const { canWrite } = useSession();
  const confirm = useConfirm();
  const runs = useQuery({
    queryKey: ['migration-runs'],
    queryFn: () => api.get<MigrationRun[]>('/api/owner/migrations/runs'),
  });
  const rollout = useAction(() => api.post<RolloutSummary>('/api/owner/migrations/rollout', {}), {
    invalidate: [['migration-runs'], ['tenants'], ['overview']],
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Tenant database migrations" />
      <Card title="Roll out the latest schema">
        <p className="mb-4 text-sm text-fg-muted">
          Applies new tenant migrations to every ready tenant database, a few at a time. The rollout
          pauses by itself if too many tenants fail, so one bad migration cannot break everyone.
        </p>
        {canWrite && (
          <Button
            type="button"
            busy={rollout.busy}
            onClick={async () => {
              if (
                !(await confirm({
                  title: 'Roll out the latest schema?',
                  body: 'New migrations are applied to every ready tenant database. Applied migrations are not rolled back.',
                  confirmLabel: 'Start the rollout',
                  tone: 'primary',
                }))
              )
                return;
              void rollout.run();
            }}
          >
            Start rollout
          </Button>
        )}
        {rollout.error && (
          <div className="mt-3">
            <Alert tone="danger">{rollout.error}</Alert>
          </div>
        )}
        {rollout.result && (
          <div className="mt-3">
            <Alert tone={rollout.result.status === 'paused' ? 'warning' : 'success'}>
              Rollout to {rollout.result.targetVersion}{' '}
              {rollout.result.status === 'paused' ? 'paused after too many failures' : 'finished'}.{' '}
              <Results counts={rollout.result.counts} />
            </Alert>
          </div>
        )}
      </Card>

      <Card title="Recent rollouts">
        {runs.isPending ? (
          <Spinner />
        ) : runs.isError ? (
          <Alert tone="danger">{errorMessage(runs.error)}</Alert>
        ) : runs.data.length === 0 ? (
          <EmptyState title="No rollouts yet">
            Each rollout started above is listed here with what happened on each tenant.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Target</th>
                <th>Status</th>
                <th>Results</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-fg-muted">{formatDateTime(r.startedAt)}</td>
                  <td className="font-mono text-xs">{r.targetVersion}</td>
                  <td>
                    <Badge
                      tone={
                        r.status === 'completed'
                          ? 'success'
                          : r.status === 'paused'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {r.status}
                    </Badge>
                  </td>
                  <td>
                    <Results counts={r.results} />
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
