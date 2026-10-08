import { Alert, Badge, Button, Card, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { api } from '../api/client';
import type { TenderDetail, TenderStatus, TenderSummary } from '../api/types';
import { daysUntil, describeError, formatDate, formatInrShort } from '../lib/format';
import { usePermission } from '../session/permissions';
import { TenderForm } from './TenderForm';

export const STATUS_LABEL: Record<TenderStatus, string> = {
  lead: 'Lead',
  evaluating: 'Evaluating',
  bidding: 'Bidding',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  no_bid: 'No bid',
  withdrawn: 'Withdrawn',
  cancelled: 'Cancelled',
};

export const statusTone = (
  s: TenderStatus,
): 'neutral' | 'accent' | 'warning' | 'danger' | 'success' =>
  s === 'won'
    ? 'success'
    : s === 'bidding' || s === 'submitted'
      ? 'accent'
      : s === 'evaluating'
        ? 'warning'
        : s === 'lost'
          ? 'danger'
          : 'neutral';

/** Changing tenders and clients needs the `tender.edit` permission (set per role by the admin). */
export const useCanEditTenders = (): boolean => usePermission('tender.edit');

/** "in 5 days", "today", "2 days late". Open tenders only; closed ones show the plain date. */
export function DueLabel({
  iso,
  open,
  relativeOnly = false,
}: {
  iso: string | null;
  open: boolean;
  relativeOnly?: boolean;
}) {
  if (!iso) return <span className="text-fg-subtle">-</span>;
  const days = daysUntil(iso);
  const date = formatDate(iso);
  if (!open) return <span className="whitespace-nowrap text-fg-muted">{date}</span>;
  const tone = days < 0 ? 'text-danger' : days <= 3 ? 'text-warning' : 'text-fg-muted';
  const rel = days < 0 ? `${-days} d late` : days === 0 ? 'today' : `in ${days} d`;
  const badge = <span className={`text-xs font-medium ${tone}`}>{rel}</span>;
  if (relativeOnly) return badge;
  return (
    <span className="whitespace-nowrap">
      {date} {badge}
    </span>
  );
}

const OPEN: TenderStatus[] = ['lead', 'evaluating', 'bidding', 'submitted'];
const FILTERS: { key: string; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'lead', label: 'Lead' },
  { key: 'evaluating', label: 'Evaluating' },
  { key: 'bidding', label: 'Bidding' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'closed', label: 'All closed' },
  { key: 'all', label: 'All' },
];

export function TendersScreen() {
  const canEdit = useCanEditTenders();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const tenders = useQuery({
    queryKey: ['tenders', filter, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (q) params.set('q', q);
      return api.request<{ items: TenderSummary[]; counts: Record<string, number> }>(
        `/api/tenant/tenders?${params}`,
      );
    },
    placeholderData: keepPreviousData,
  });
  const counts = tenders.data?.counts ?? {};
  const count = (key: string) =>
    key === 'all'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : key === 'open'
        ? OPEN.reduce((a, s) => a + (counts[s] ?? 0), 0)
        : key === 'closed'
          ? Object.entries(counts)
              .filter(([s]) => !OPEN.includes(s as TenderStatus))
              .reduce((a, [, n]) => a + n, 0)
          : (counts[key] ?? 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tenders"
        actions={
          canEdit && (
            <Button onClick={() => void navigate({ to: '/tenders/new' })}>
              <Plus className="size-4" aria-hidden /> New tender
            </Button>
          )
        }
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-md px-2.5 py-1.5 text-sm ${filter === f.key ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2'}`}
          >
            {f.label} <span className="tabular-nums text-fg-subtle">{count(f.key)}</span>
          </button>
        ))}
      </div>
      <Card>
        <div className="relative mb-4 max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search tenders"
            placeholder="Title, number, client, location"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tenders.isPending ? (
          <Spinner />
        ) : tenders.isError ? (
          <Alert tone="danger">{describeError(tenders.error)}</Alert>
        ) : tenders.data.items.length === 0 ? (
          <div className="py-8 text-center text-sm text-fg-muted">
            {q || filter !== 'open' ? (
              'No tenders match.'
            ) : canEdit ? (
              <>
                No open tenders.{' '}
                <Link to="/tenders/new" className="text-accent hover:underline">
                  Add the first one
                </Link>
                .
              </>
            ) : (
              'No open tenders.'
            )}
          </div>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Tender</th>
                <th>Due</th>
                <th className="text-right">Value</th>
                <th>Status</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {tenders.data.items.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap font-mono text-xs text-fg-muted">{t.number}</td>
                  <td className="max-w-[24rem]">
                    <Link
                      to="/tenders/$tenderId"
                      params={{ tenderId: t.id }}
                      className="font-medium text-accent hover:underline"
                    >
                      {t.title}
                    </Link>
                    <div className="truncate text-xs text-fg-muted">
                      {[t.client?.name, t.location].filter(Boolean).join(' · ') || '-'}
                    </div>
                  </td>
                  <td>
                    <DueLabel iso={t.submissionDueAt} open={OPEN.includes(t.status)} />
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatInrShort(t.estimatedValue)}
                  </td>
                  <td>
                    <Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Badge>
                  </td>
                  <td className="text-fg-muted">{t.owner?.displayName ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

export function NewTenderScreen() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="New tender"
        subtitle="Only the title is required. Add the rest as you learn it; deadline reminders follow the dates."
      />
      <Card>
        <TenderForm
          submitLabel="Create tender"
          onCancel={() => void navigate({ to: '/tenders' })}
          onSubmit={async (body) => {
            const t = await api.request<TenderDetail>('/api/tenant/tenders', {
              method: 'POST',
              body,
            });
            await navigate({ to: '/tenders/$tenderId', params: { tenderId: t.id } });
          }}
        />
      </Card>
    </div>
  );
}
