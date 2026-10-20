// The audit trail (docs/wave7-plan.md step 7a.8): who created, changed or removed which record and when, with the
// fields changed. Admin only; filtered by person, kind of record, record and dates; older entries page in.
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
} from '@aerolith/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatDateTime } from '../lib/format';

interface Entry {
  id: number;
  at: string;
  actorId: string | null;
  actor: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  data: Record<string, unknown>;
}
interface Page {
  rows: Entry[];
  more: boolean;
  entities: string[];
}

const ACTION: Record<string, string> = { insert: 'Created', update: 'Changed', delete: 'Removed' };
const words = (s: string) => s.replace(/^[a-z]+\./, '').replace(/_/g, ' ');
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '–' : String(v));

/** What happened, in a line: the fields changed (old → new), or the record's number and name. */
function describe(e: Entry): string {
  const changed = e.data.changed as Record<string, [unknown, unknown] | null> | undefined;
  if (changed)
    return Object.entries(changed)
      .map(([k, v]) => (v ? `${words(k)}: ${show(v[0])} → ${show(v[1])}` : words(k)))
      .join('; ');
  return [e.data.number, e.data.name, e.data.status]
    .filter((x) => typeof x === 'string' && x)
    .join(' · ');
}

export function AuditScreen() {
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.request<{ id: string; displayName: string }[]>('/api/tenant/users'),
  });
  const [userId, setUserId] = useState('');
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = new URLSearchParams();
  if (userId) params.set('userId', userId);
  if (entity) params.set('entity', entity);
  if (entityId.trim()) params.set('entityId', entityId.trim());
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const trail = useInfiniteQuery({
    queryKey: ['audit', params.toString()],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set('before', String(pageParam));
      return api.request<Page>(`/api/tenant/audit?${p.toString()}`);
    },
    getNextPageParam: (last) => (last.more ? last.rows.at(-1)?.id : undefined),
  });
  const rows = trail.data?.pages.flatMap((p) => p.rows) ?? [];
  const entities = trail.data?.pages[0]?.entities ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit trail"
        subtitle="Who created, changed or removed which record, and when. Newest first."
      />
      <Card>
        <form
          aria-label="Filters"
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => e.preventDefault()}
        >
          <Select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Anyone</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </Select>
          <Select aria-label="Record" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Any record</option>
            {entities.map((k) => (
              <option key={k} value={k}>
                {words(k)}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Record id"
            placeholder="Record id"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            From
            <Input
              type="date"
              aria-label="From"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            to
            <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </form>
        {trail.isPending ? (
          <Spinner />
        ) : trail.isError ? (
          <Alert tone="danger">{describeError(trail.error)}</Alert>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing recorded here.">
            Widen the dates or clear a filter to see more of the trail.
          </EmptyState>
        ) : (
          <>
            <Table minWidth="52rem">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Record</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody aria-label="Audit trail">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-sm">{formatDateTime(e.at)}</td>
                    <td className="text-sm">{e.actor ?? '–'}</td>
                    <td className="text-sm">
                      {ACTION[e.action] ?? e.action.replace(/[._]/g, ' ')}
                    </td>
                    <td className="text-sm">
                      {words(e.entity)}
                      {e.entityId ? (
                        <button
                          type="button"
                          className="ml-1 font-mono text-xs text-fg-subtle hover:underline"
                          title="Show this record's history"
                          onClick={() => {
                            setEntity(e.entity);
                            setEntityId(e.entityId ?? '');
                          }}
                        >
                          {e.entityId.slice(0, 8)}
                        </button>
                      ) : null}
                    </td>
                    <td className="text-sm text-fg-muted">{describe(e)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {trail.hasNextPage ? (
              <div className="mt-3 text-center">
                <Button
                  variant="secondary"
                  onClick={() => void trail.fetchNextPage()}
                  busy={trail.isFetchingNextPage}
                >
                  Older
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
