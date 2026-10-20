import { Alert, Button, Card, EmptyState, Spinner } from '@aerolith/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, type AuditRow } from '../api';
import { errorMessage, formatDateTime } from '../format';
import { PageHeader, Table } from './Shell';

const PAGE = 50;

const ACTIONS: Record<string, string> = {
  'tenant.create_trial': 'Created trial',
  'licence.trial_extended': 'Extended trial',
  'licence.trial_shortened': 'Shortened trial',
  'licence.revoke': 'Revoked licence',
  'licence.device_revoke': 'Removed device',
  'licence.reveal_key': 'Viewed licence key',
  'licence.resend_key': 'Emailed licence key',
  'operator.reset': 'Reset operator (server command)',
};

/** Shows the details that help, never secrets (the API stores none in the audit log). */
function details(row: AuditRow): string {
  const { actor: _actor, ...rest } = row.data;
  return Object.entries(rest)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

function Target({ target }: { target: string }) {
  const [kind, id] = target.split(':');
  if (kind === 'tenant' && id)
    return (
      <Link
        to="/tenants/$tenantId"
        params={{ tenantId: id }}
        className="text-accent hover:underline"
      >
        tenant
      </Link>
    );
  return <span className="text-fg-muted">{kind}</span>;
}

export function AuditScreen() {
  const audit = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) =>
      api.get<AuditRow[]>(
        `/api/owner/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" />
      <Card>
        <p className="mb-3 text-sm text-fg-muted">
          Every change made from this console, newest first. Entries cannot be edited or deleted.
        </p>
        {audit.isPending ? (
          <Spinner />
        ) : audit.isError ? (
          <Alert tone="danger">{errorMessage(audit.error)}</Alert>
        ) : audit.data.pages[0]!.length === 0 ? (
          <EmptyState title="Nothing yet">
            Each change made from this console is recorded here as it happens.
          </EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>On</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.pages.flat().map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-fg-muted">
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className="whitespace-nowrap font-medium">
                      {ACTIONS[r.action] ?? r.action}
                    </td>
                    <td>
                      <Target target={r.target} />
                    </td>
                    <td className="max-w-[28rem] truncate text-fg-muted" title={details(r)}>
                      {details(r)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {audit.hasNextPage && (
              <div className="mt-4">
                <Button
                  type="button"
                  variant="secondary"
                  busy={audit.isFetchingNextPage}
                  onClick={() => void audit.fetchNextPage()}
                >
                  Load older
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
