// Every enquiry (RFQ) the person may see, from tenders and from projects (docs/wave7-plan.md step 7a.2): one list for
// estimation and purchase, instead of opening each tender or project first.
import {
  Alert,
  Badge,
  Card,
  DataGrid,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  type GridColumn,
} from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { day, useGridStorage } from '../lib/grid';
import { shortDate } from '../schedule/model';

interface RfqRow {
  id: string;
  number: string;
  title: string;
  kind: 'work' | 'material';
  dueOn: string | null;
  status: string;
  lines: number;
  vendors: number;
  quotes: number;
  tender: { id: string; number: string; title: string } | null;
  project: { id: string; number: string; name: string } | null;
}
const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning'> = {
  draft: 'neutral',
  sent: 'accent',
  closed: 'success',
  cancelled: 'warning',
};

const columns: GridColumn<RfqRow>[] = [
  {
    id: 'rfq',
    header: 'RFQ',
    width: 260,
    hideable: false,
    value: (r) => `${r.number} ${r.title}`,
    cell: (r) => (
      <Link to="/rfqs/$rfqId" params={{ rfqId: r.id }} className="hover:underline">
        <span className="font-mono text-xs">{r.number}</span> {r.title}
      </Link>
    ),
  },
  {
    id: 'for',
    header: 'For',
    width: 220,
    value: (r) =>
      r.tender ? `Tender: ${r.tender.title}` : r.project ? `Project: ${r.project.name}` : null,
    cell: (r) =>
      r.tender ? (
        <Link
          to="/tenders/$tenderId"
          params={{ tenderId: r.tender.id }}
          className="text-sm hover:underline"
        >
          Tender: {r.tender.title}
        </Link>
      ) : r.project ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: r.project.id }}
          className="text-sm hover:underline"
        >
          Project: {r.project.name}
        </Link>
      ) : null,
  },
  { id: 'kind', header: 'Kind', width: 100, value: (r) => r.kind, cell: (r) => r.kind },
  {
    id: 'dueOn',
    header: 'Quotes due',
    width: 120,
    value: (r) => day(r.dueOn),
    cell: (r) => (r.dueOn ? shortDate(r.dueOn) : '-'),
  },
  {
    id: 'lines',
    header: 'Lines',
    align: 'right',
    width: 80,
    value: (r) => r.lines,
    cell: (r) => r.lines,
  },
  {
    id: 'quotes',
    header: 'Quotes',
    align: 'right',
    width: 100,
    value: (r) => r.quotes,
    cell: (r) => `${r.quotes} of ${r.vendors}`,
  },
  {
    id: 'status',
    header: 'Status',
    width: 110,
    value: (r) => r.status,
    cell: (r) => <Badge tone={TONE[r.status] ?? 'neutral'}>{r.status}</Badge>,
  },
];

export function RfqsScreen() {
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('all');
  const list = useQuery({
    queryKey: ['rfqs', status, source],
    queryFn: () => api.request<RfqRow[]>(`/api/tenant/rfqs?status=${status}&source=${source}`),
    placeholderData: keepPreviousData,
  });
  const storage = useGridStorage('rfqs');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Enquiries (RFQs)"
        subtitle="Requests for quotation from tenders and projects. Open one to send it, record quotes and compare."
      />
      <Card>
        <div className="mb-4 flex flex-wrap gap-3">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open (draft or sent)</option>
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select aria-label="From" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">Tenders and projects</option>
            <option value="tender">Tenders</option>
            <option value="project">Projects</option>
          </Select>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : (
          <DataGrid
            id="rfqs"
            label="Enquiries"
            columns={columns}
            rows={list.data}
            rowKey={(r) => r.id}
            storage={storage}
            exportName="Enquiries"
            empty={
              <EmptyState title="No enquiries here.">
                Start an enquiry from a tender&rsquo;s BOQ or a project&rsquo;s requisitions.
              </EmptyState>
            }
          />
        )}
      </Card>
    </div>
  );
}
