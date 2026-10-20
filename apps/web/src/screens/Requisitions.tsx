// Purchase requisitions across the projects I am on (docs/wave2b-plan.md step 1). New ones are raised from a
// project's page.
import {
  Alert,
  Badge,
  Card,
  DataGrid,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Spinner,
  type GridColumn,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatInr } from '../lib/format';
import { day, num, useGridStorage } from '../lib/grid';
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
  // The company-wide list and a project's own list keep separate layouts: the project column is only on the first.
  const id = showProject ? 'requisitions' : 'project-requisitions';
  const storage = useGridStorage(id);
  const columns: GridColumn<RequisitionRow>[] = [
    {
      id: 'requisition',
      header: 'Requisition',
      width: 260,
      hideable: false,
      value: (r) => r.title,
      cell: (r) => (
        <>
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
        </>
      ),
    },
    ...(showProject
      ? [
          {
            id: 'project',
            header: 'Project',
            width: 220,
            value: (r: RequisitionRow) => `${r.project.number} · ${r.project.name}`,
            cell: (r: RequisitionRow) => (
              <span className="text-sm">
                {r.project.number} · {r.project.name}
              </span>
            ),
          },
        ]
      : []),
    {
      id: 'amount',
      header: 'Estimated',
      align: 'right',
      width: 130,
      value: (r) => num(r.amount),
      cell: (r) => formatInr(r.amount),
    },
    {
      id: 'neededBy',
      header: 'Needed by',
      width: 120,
      value: (r) => day(r.neededBy),
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{shortDate(r.neededBy)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 160,
      value: (r) => REQUISITION_STATUS[r.status],
      cell: (r) => <Badge tone={REQUISITION_TONE[r.status]}>{REQUISITION_STATUS[r.status]}</Badge>,
    },
  ];
  return (
    <DataGrid
      id={id}
      label="Requisitions"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      storage={storage}
      exportName="Requisitions"
      empty={
        <EmptyState title="No requisitions.">
          A site raises a requisition from its project's page for the materials it needs.
        </EmptyState>
      }
    />
  );
}
