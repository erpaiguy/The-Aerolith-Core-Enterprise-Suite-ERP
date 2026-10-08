import { Alert, Badge, Card, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, type Overview } from '../api';
import { daysUntil, dbTone, errorMessage, formatDate, licenceTone } from '../format';
import { PageHeader, Stat } from './Shell';

const LICENCE_LABELS: Record<string, string> = {
  active: 'Active',
  grace: 'Grace period',
  read_only: 'Read-only',
  suspended: 'Suspended',
  revoked: 'Revoked',
  none: 'No licence',
};

export function OverviewScreen() {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<Overview>('/api/owner/overview'),
    refetchInterval: 60_000,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  const o = q.data;
  const dbProblems = (o.databases.failed ?? 0) + (o.databases.unreachable ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tenants" value={o.tenants} />
        <Stat label="Trials ending in 14 days" value={o.trialsEndingSoon.length} />
        <Stat
          label="Database problems"
          value={dbProblems}
          {...(dbProblems ? { tone: 'danger' as const } : {})}
        />
        <Stat
          label="Failed emails (7 days)"
          value={o.email.failedLast7Days}
          {...(o.email.failedLast7Days ? { tone: 'danger' as const } : {})}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Trials ending soon">
          {o.trialsEndingSoon.length === 0 ? (
            <p className="text-sm text-fg-muted">No trial ends in the next 14 days.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {o.trialsEndingSoon.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    to="/tenants/$tenantId"
                    params={{ tenantId: t.id }}
                    className="truncate text-accent hover:underline"
                  >
                    {t.name}
                  </Link>
                  <span className="shrink-0 text-fg-muted">
                    {formatDate(t.endsAt)} · {daysUntil(t.endsAt)} d
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Licences and databases">
          <div className="grid grid-cols-2 gap-6 text-sm">
            <ul className="space-y-1.5">
              {Object.entries(o.licenceStates).map(([state, n]) => (
                <li key={state} className="flex items-center justify-between gap-2">
                  <Badge tone={licenceTone(state)}>{LICENCE_LABELS[state] ?? state}</Badge>
                  <span className="tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-1.5">
              {Object.entries(o.databases).map(([status, n]) => (
                <li key={status} className="flex items-center justify-between gap-2">
                  <Badge tone={status === 'not_started' ? 'neutral' : dbTone(status)}>
                    {status.replace('_', ' ')}
                  </Badge>
                  <span className="tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          </div>
          {o.tenants === 0 && (
            <p className="mt-3 text-sm text-fg-muted">
              No tenants yet.{' '}
              <Link to="/tenants" className="text-accent hover:underline">
                Create a trial
              </Link>
              .
            </p>
          )}
        </Card>
      </div>

      <Card title="Email">
        <p className="text-sm text-fg-muted">
          {o.email.sentLastDay} sent in the last 24 hours · {o.email.queued} waiting ·{' '}
          <Link to="/email" className="text-accent hover:underline">
            details
          </Link>
        </p>
      </Card>
    </div>
  );
}
