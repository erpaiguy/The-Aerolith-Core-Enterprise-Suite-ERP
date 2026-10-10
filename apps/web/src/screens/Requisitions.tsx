// Purchase requisitions across the projects I am on (docs/wave2b-plan.md step 1). New ones are raised from a
// project's page.
import { Alert, Badge, Card, Field, PageHeader, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatInr } from '../lib/format';
import { REQUISITION_STATUS, REQUISITION_TONE, type RequisitionRow } from '../procurement/model';
import { shortDate } from '../schedule/model';

export function RequisitionsScreen() {
  const [status, setStatus] = useState('open');
  const rows = useQuery({
    queryKey: ['requisitions', 'all', status],
    queryFn: () =>
      api.request<RequisitionRow[]>(`/api/tenant/requisitions${status ? `?status=${status}` : ''}`),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Requisitions"
        subtitle="What the projects you are on ask to be bought. Raise one from a project's page."
      />
      <div className="w-56">
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open (draft, waiting, rejected)</option>
            <option value="submitted">Waiting for approval</option>
            <option value="approved">Approved</option>
            <option value="cancelled">Cancelled</option>
            <option value="">All</option>
          </Select>
        </Field>
      </div>
      <Card>
        {rows.isPending ? (
          <Spinner />
        ) : rows.isError ? (
          <Alert tone="danger">{describeError(rows.error)}</Alert>
        ) : (
          <RequisitionTable rows={rows.data} showProject />
        )}
      </Card>
    </div>
  );
}

export function RequisitionTable({
  rows,
  showProject = false,
}: {
  rows: RequisitionRow[];
  showProject?: boolean;
}) {
  if (!rows.length) return <p className="text-sm text-fg-muted">None.</p>;
  return (
    <Table minWidth="44rem">
      <thead>
        <tr>
          <th>Requisition</th>
          {showProject && <th>Project</th>}
          <th className="text-right">Estimated</th>
          <th>Needed by</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody aria-label="Requisitions">
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link
                to="/requisitions/$requisitionId"
                params={{ requisitionId: r.id }}
                className="text-accent hover:underline"
              >
                {r.title}
              </Link>
              <span className="block text-xs text-fg-muted">
                <span className="font-mono">{r.number}</span> · {r.lines} line
                {r.lines === 1 ? '' : 's'}
                {r.createdBy && ` · ${r.createdBy}`}
              </span>
            </td>
            {showProject && (
              <td className="text-sm">
                {r.project.number} · {r.project.name}
              </td>
            )}
            <td className="text-right tabular-nums">{formatInr(r.amount)}</td>
            <td className="whitespace-nowrap tabular-nums">{shortDate(r.neededBy)}</td>
            <td>
              <Badge tone={REQUISITION_TONE[r.status]}>{REQUISITION_STATUS[r.status]}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
