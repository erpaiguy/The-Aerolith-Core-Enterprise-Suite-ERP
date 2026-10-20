// Every enquiry (RFQ) the person may see, from tenders and from projects (docs/wave7-plan.md step 7a.2): one list for
// estimation and purchase, instead of opening each tender or project first.
import { Alert, Badge, Card, EmptyState, PageHeader, Select, Spinner, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
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

export function RfqsScreen() {
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('all');
  const list = useQuery({
    queryKey: ['rfqs', status, source],
    queryFn: () => api.request<RfqRow[]>(`/api/tenant/rfqs?status=${status}&source=${source}`),
    placeholderData: keepPreviousData,
  });
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
        ) : list.data.length === 0 ? (
          <EmptyState title="No enquiries here.">
            Start an enquiry from a tender&rsquo;s BOQ or a project&rsquo;s requisitions.
          </EmptyState>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>RFQ</th>
                <th>For</th>
                <th>Kind</th>
                <th>Quotes due</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Quotes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody aria-label="Enquiries">
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to="/rfqs/$rfqId" params={{ rfqId: r.id }} className="hover:underline">
                      <span className="font-mono text-xs">{r.number}</span> {r.title}
                    </Link>
                  </td>
                  <td className="text-sm">
                    {r.tender ? (
                      <Link
                        to="/tenders/$tenderId"
                        params={{ tenderId: r.tender.id }}
                        className="hover:underline"
                      >
                        Tender: {r.tender.title}
                      </Link>
                    ) : r.project ? (
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: r.project.id }}
                        className="hover:underline"
                      >
                        Project: {r.project.name}
                      </Link>
                    ) : null}
                  </td>
                  <td>{r.kind}</td>
                  <td>{r.dueOn ? shortDate(r.dueOn) : '-'}</td>
                  <td className="text-right">{r.lines}</td>
                  <td className="text-right">
                    {r.quotes} of {r.vendors}
                  </td>
                  <td>
                    <Badge tone={TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
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
