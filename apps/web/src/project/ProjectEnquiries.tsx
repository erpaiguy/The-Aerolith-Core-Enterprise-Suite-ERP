// A project's enquiries to vendors (docs/wave2b-plan.md step 3): Wave 1's RFQs, for what its approved requisitions
// need. Started here (with the requisitions ticked) or from a requisition's page; worked on the RFQ's page.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Spinner,
  Table,
  toast,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail, RfqDetail, RfqStatus } from '../api/types';
import { useRun } from '../approvals/model';
import { describeError, formatInr } from '../lib/format';
import type { RequisitionRow } from '../procurement/model';
import { shortDate } from '../schedule/model';
import { usePermission } from '../session/permissions';

interface ProjectRfq {
  id: string;
  number: string;
  title: string;
  kind: 'work' | 'material';
  dueOn: string | null;
  status: RfqStatus;
  lines: number;
  vendors: number;
  quotes: number;
  chosen: number;
}

const STATUS: Record<RfqStatus, string> = {
  draft: 'Draft',
  sent: 'Out',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export function ProjectEnquiries({ project: p }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const canRfq = usePermission('rfq.edit');
  const mayStart = canRfq && (p.canEdit || p.myRole === 'lead' || p.myRole === 'member');
  const rfqs = useQuery({
    queryKey: ['project-rfqs', p.id],
    queryFn: () => api.request<ProjectRfq[]>(`/api/tenant/projects/${p.id}/rfqs`),
  });
  const [starting, setStarting] = useState(false);
  return (
    <Card
      title={`Enquiries${rfqs.data ? ` (${rfqs.data.length})` : ''}`}
      actions={
        mayStart &&
        !starting && (
          <Button variant="secondary" onClick={() => setStarting(true)}>
            <Plus className="size-4" aria-hidden /> New enquiry
          </Button>
        )
      }
    >
      {starting && (
        <NewEnquiry
          projectId={p.id}
          onCancel={() => setStarting(false)}
          onMade={(id) => void navigate({ to: '/rfqs/$rfqId', params: { rfqId: id } })}
        />
      )}
      {rfqs.isPending ? (
        <Spinner />
      ) : rfqs.isError ? (
        <Alert tone="danger">{describeError(rfqs.error)}</Alert>
      ) : rfqs.data.length === 0 ? (
        <EmptyState title="None yet.">
          Ask vendors to quote for what approved requisitions need.
        </EmptyState>
      ) : (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Enquiry</th>
              <th>Quotes due</th>
              <th className="text-right">Vendors</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody aria-label="Enquiries">
            {rfqs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link
                    to="/rfqs/$rfqId"
                    params={{ rfqId: r.id }}
                    className="text-accent hover:underline"
                  >
                    {r.title}
                  </Link>
                  <span className="block text-xs text-fg-muted">
                    <span className="font-mono">{r.number}</span> · {r.lines} line
                    {r.lines === 1 ? '' : 's'}
                    {r.chosen > 0 && ` · ${r.chosen} chosen`}
                  </span>
                </td>
                <td className="whitespace-nowrap tabular-nums">{shortDate(r.dueOn)}</td>
                <td className="text-right tabular-nums">
                  {r.quotes} of {r.vendors} quoted
                </td>
                <td>
                  <Badge tone={r.status === 'sent' ? 'warning' : 'neutral'}>
                    {STATUS[r.status]}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function NewEnquiry({
  projectId,
  onCancel,
  onMade,
}: {
  projectId: string;
  onCancel: () => void;
  onMade: (id: string) => void;
}) {
  const reqs = useQuery({
    queryKey: ['requisitions', 'project', projectId, 'approved'],
    queryFn: () =>
      api.request<RequisitionRow[]>(
        `/api/tenant/requisitions?projectId=${projectId}&status=approved`,
      ),
  });
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { run, busy, error } = useRun(() => undefined);
  return (
    <form
      className="mb-4 space-y-3 rounded-md border border-line p-3"
      aria-label="New enquiry"
      onSubmit={(e) => {
        e.preventDefault();
        void run('make', async () => {
          const r = await api.request<RfqDetail>(`/api/tenant/projects/${projectId}/rfqs`, {
            method: 'POST',
            body: { title: title.trim(), dueOn: dueOn || null, requisitionIds: [...picked] },
          });
          toast.success(`Enquiry ${r.number} started`);
          onMade(r.id);
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Field label="Enquiry title">
            <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </div>
        <Field label="Quotes due">
          <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
      </div>
      {reqs.data && reqs.data.length > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-sm font-medium">For these approved requisitions</legend>
          {reqs.data.map((q) => (
            <label key={q.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.has(q.id)}
                onChange={(e) => {
                  const n = new Set(picked);
                  if (e.target.checked) n.add(q.id);
                  else n.delete(q.id);
                  setPicked(n);
                }}
              />
              <span className="font-mono text-xs">{q.number}</span> {q.title}
              <span className="text-xs text-fg-muted">({formatInr(q.amount)})</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex gap-2">
        <Button type="submit" busy={busy === 'make'} disabled={title.trim().length < 3}>
          Start the enquiry
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}
