// Company-wide registers (docs/wave7-plan.md step 7a.3): the records kept inside projects (daily reports, bills,
// drawings, RFIs, inspections, NCRs, store issues and transfers), listed across every project the person can see, with
// project, status, date and text filters. Each row opens the record's own screen.
import { Alert, Badge, Card, Input, PageHeader, Select, Spinner, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { api } from '../api/client';
import type { ProjectSummary } from '../api/types';
import { describeError, formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';
import { useProjectParam } from '../lib/project-param';

export const REGISTER_KINDS = [
  'daily-reports',
  'client-bills',
  'subcontract-bills',
  'drawings',
  'rfis',
  'inspections',
  'ncrs',
  'stock-issues',
  'stock-transfers',
] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number];

type Row = Record<string, unknown> & {
  id: string;
  project: { id: string; number: string; name: string };
};
const s = (v: unknown) => (v == null || v === '' ? '-' : String(v));
const d = (v: unknown) => (typeof v === 'string' && v ? shortDate(v) : '-');
const label = (v: string) => v.replace(/_/g, ' ');
const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  pending: 'accent',
  submitted: 'accent',
  requested: 'accent',
  open: 'warning',
  in_transit: 'accent',
  answered: 'accent',
  action_taken: 'accent',
  acknowledged: 'success',
  certified: 'success',
  approved: 'success',
  approved_with_comments: 'success',
  received: 'success',
  closed: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};
const status = (v: unknown) => (
  <Badge tone={TONE[String(v)] ?? 'neutral'}>{label(String(v))}</Badge>
);

interface Column {
  head: string;
  cell: (r: Row) => ReactNode;
  right?: boolean;
}
interface Spec {
  title: string;
  subtitle: string;
  /** The status filter's label and choices (drawings filter by discipline). */
  statusLabel: string;
  statuses: string[];
  /** The date the from/to filter applies to. */
  dateLabel: string;
  columns: Column[];
}

const SPECS: Record<RegisterKind, Spec> = {
  'daily-reports': {
    title: 'Daily reports',
    subtitle: "Every site's daily report across projects.",
    statusLabel: 'Status',
    statuses: ['draft', 'submitted', 'acknowledged'],
    dateLabel: 'Report date',
    columns: [
      {
        head: 'Date',
        cell: (r) => (
          <Link
            to="/daily-reports/$reportId"
            params={{ reportId: r.id }}
            className="hover:underline"
          >
            {d(r.date)}
          </Link>
        ),
      },
      { head: 'Site', cell: (r) => s(r.site) },
      { head: 'Submitted by', cell: (r) => s(r.submittedBy) },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  'client-bills': {
    title: 'Client bills',
    subtitle: 'Running-account bills to clients, across projects.',
    statusLabel: 'Status',
    statuses: ['draft', 'pending', 'submitted', 'certified', 'cancelled'],
    dateLabel: 'Work up to',
    columns: [
      {
        head: 'RA bill',
        cell: (r) => (
          <Link to="/client-bills/$billId" params={{ billId: r.id }} className="hover:underline">
            RA {s(r.raNo)}
          </Link>
        ),
      },
      { head: 'Up to', cell: (r) => d(r.upto) },
      { head: 'Client', cell: (r) => s(r.client) },
      { head: 'Invoice', cell: (r) => s(r.invoiceNo) },
      { head: 'Certified', cell: (r) => d(r.certifiedOn) },
      { head: 'Net', cell: (r) => formatInr(r.net as string | null), right: true },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  'subcontract-bills': {
    title: 'Subcontract bills',
    subtitle: "Subcontractors' running-account bills, across projects.",
    statusLabel: 'Status',
    statuses: ['draft', 'pending', 'certified', 'cancelled'],
    dateLabel: 'Work up to',
    columns: [
      {
        head: 'RA bill',
        cell: (r) => (
          <Link
            to="/subcontract-bills/$billId"
            params={{ billId: r.id }}
            className="hover:underline"
          >
            RA {s(r.raNo)}
          </Link>
        ),
      },
      { head: 'Up to', cell: (r) => d(r.upto) },
      { head: 'Subcontractor', cell: (r) => s(r.subcontractor) },
      { head: 'Work order', cell: (r) => s(r.order) },
      { head: 'Net', cell: (r) => formatInr(r.net as string | null), right: true },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  drawings: {
    title: 'Drawings',
    subtitle: 'Every drawing received, its latest revision and purpose, across projects.',
    statusLabel: 'Discipline',
    statuses: [
      'architectural',
      'structural',
      'electrical',
      'plumbing',
      'hvac',
      'fire',
      'landscape',
      'interiors',
      'other',
    ],
    dateLabel: 'Received',
    columns: [
      {
        head: 'Drawing',
        cell: (r) => (
          <Link
            to="/projects/$projectId/documents"
            params={{ projectId: r.project.id }}
            className="hover:underline"
          >
            <span className="font-mono text-xs">{s(r.number)}</span> {s(r.title)}
          </Link>
        ),
      },
      { head: 'Discipline', cell: (r) => label(s(r.discipline)) },
      { head: 'Revision', cell: (r) => s(r.revision) },
      { head: 'Received', cell: (r) => d(r.receivedOn) },
      { head: 'Purpose', cell: (r) => label(s(r.purpose)) },
    ],
  },
  rfis: {
    title: 'RFIs',
    subtitle: 'Requests for information from site, across projects.',
    statusLabel: 'Status',
    statuses: ['open', 'answered', 'closed'],
    dateLabel: 'Raised',
    columns: [
      {
        head: 'RFI',
        cell: (r) => (
          <Link to="/transmittals" search={{ project: r.project.id }} className="hover:underline">
            <span className="font-mono text-xs">{s(r.number)}</span> {s(r.subject)}
          </Link>
        ),
      },
      { head: 'Raised', cell: (r) => d(r.raised) },
      { head: 'Assigned to', cell: (r) => s(r.assignedTo) },
      {
        head: 'Due',
        cell: (r) => (
          <span className={r.overdue ? 'font-medium text-danger' : undefined}>{d(r.dueOn)}</span>
        ),
      },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  inspections: {
    title: 'Inspections',
    subtitle: 'Requests for inspection and their decisions, across projects.',
    statusLabel: 'Status',
    statuses: ['requested', 'approved', 'approved_with_comments', 'rejected'],
    dateLabel: 'Requested for',
    columns: [
      {
        head: 'Inspection',
        cell: (r) => (
          <Link to="/quality" search={{ project: r.project.id }} className="hover:underline">
            <span className="font-mono text-xs">{s(r.number)}</span> {s(r.activity)}
          </Link>
        ),
      },
      { head: 'Location', cell: (r) => s(r.location) },
      { head: 'For', cell: (r) => d(r.requestedFor) },
      { head: 'Inspector', cell: (r) => s(r.inspector) },
      { head: 'Decided', cell: (r) => d(r.decidedOn) },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  ncrs: {
    title: 'NCRs',
    subtitle: 'Non-conformance reports and their closure, across projects.',
    statusLabel: 'Status',
    statuses: ['open', 'action_taken', 'closed'],
    dateLabel: 'Raised',
    columns: [
      {
        head: 'NCR',
        cell: (r) => (
          <Link to="/quality" search={{ project: r.project.id }} className="hover:underline">
            <span className="font-mono text-xs">{s(r.number)}</span> {s(r.description)}
          </Link>
        ),
      },
      { head: 'Raised', cell: (r) => d(r.raised) },
      { head: 'Source', cell: (r) => label(s(r.source)) },
      { head: 'Responsible', cell: (r) => s(r.responsible) },
      { head: 'Due', cell: (r) => d(r.dueOn) },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
  'stock-issues': {
    title: 'Stock issues',
    subtitle: 'Material issued from stores to work, across projects.',
    statusLabel: '',
    statuses: [],
    dateLabel: 'Issued on',
    columns: [
      {
        head: 'Issue',
        cell: (r) => (
          <Link to="/issues/$issueId" params={{ issueId: r.id }} className="hover:underline">
            <span className="font-mono text-xs">{s(r.number)}</span>
          </Link>
        ),
      },
      { head: 'Issued on', cell: (r) => d(r.issuedOn) },
      { head: 'Store', cell: (r) => s(r.store) },
      { head: 'To', cell: (r) => s(r.issuedTo) },
      { head: 'WBS', cell: (r) => s(r.wbs) },
      { head: 'Value', cell: (r) => formatInr(r.value as string | null), right: true },
    ],
  },
  'stock-transfers': {
    title: 'Stock transfers',
    subtitle: 'Material moved between stores, across projects.',
    statusLabel: 'Status',
    statuses: ['in_transit', 'received', 'cancelled'],
    dateLabel: 'Sent on',
    columns: [
      {
        head: 'Transfer',
        cell: (r) => (
          <Link
            to="/transfers/$transferId"
            params={{ transferId: r.id }}
            className="hover:underline"
          >
            <span className="font-mono text-xs">{s(r.number)}</span>
          </Link>
        ),
      },
      { head: 'Sent', cell: (r) => d(r.sentOn) },
      { head: 'From', cell: (r) => s(r.from) },
      { head: 'To', cell: (r) => s(r.to) },
      { head: 'Received', cell: (r) => d(r.receivedOn) },
      { head: 'Status', cell: (r) => status(r.status) },
    ],
  },
};

export function RegisterScreen({ kind }: { kind: RegisterKind }) {
  const spec = SPECS[kind];
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (state) params.set('status', state);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({
    queryKey: ['registers', kind, params.toString()],
    queryFn: () =>
      api.request<{ rows: Row[]; limited: boolean }>(
        `/api/tenant/registers/${kind}?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-5">
      <PageHeader title={spec.title} subtitle={spec.subtitle} />
      <Card>
        <form
          aria-label="Filters"
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => e.preventDefault()}
        >
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
          {spec.statuses.length > 0 ? (
            <Select
              aria-label={spec.statusLabel}
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">Any {spec.statusLabel.toLowerCase()}</option>
              {spec.statuses.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </Select>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            {spec.dateLabel} from
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
          <Input
            type="search"
            aria-label="Search"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">Nothing here.</p>
        ) : (
          <>
            {list.data.limited ? (
              <Alert tone="info">
                The first 1,000 are shown; narrow the filters to see the rest.
              </Alert>
            ) : null}
            <Table minWidth="52rem">
              <thead>
                <tr>
                  <th>Project</th>
                  {spec.columns.map((c) => (
                    <th key={c.head} className={c.right ? 'text-right' : undefined}>
                      {c.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody aria-label={spec.title}>
                {list.data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm">
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: r.project.id }}
                        className="hover:underline"
                      >
                        {r.project.name}
                      </Link>
                    </td>
                    {spec.columns.map((c) => (
                      <td key={c.head} className={c.right ? 'text-right' : undefined}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}
