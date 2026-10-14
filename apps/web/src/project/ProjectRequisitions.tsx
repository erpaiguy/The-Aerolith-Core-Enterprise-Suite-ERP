// A project's purchase requisitions on its page (docs/wave2b-plan.md step 1), and a new one: a title first, then its
// lines on the requisition's own page.
import { Alert, Button, Card, Field, Input, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { useRun } from '../approvals/model';
import { describeError } from '../lib/format';
import type { Requisition, RequisitionRow } from '../procurement/model';
import { RequisitionTable } from '../screens/Requisitions';
import { useFocusForm, useNewParam } from '../lib/new-param';

export function ProjectRequisitions({ project: p }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const rows = useQuery({
    queryKey: ['requisitions', 'project', p.id],
    queryFn: () => api.request<RequisitionRow[]>(`/api/tenant/requisitions?projectId=${p.id}`),
  });
  const mayRaise = p.canEdit || p.myRole === 'lead' || p.myRole === 'member';
  const asked = useNewParam('requisition') && mayRaise;
  const [title, setTitle] = useState<string | null>(asked ? '' : null);
  useEffect(() => {
    if (asked) setTitle((t) => t ?? '');
  }, [asked]);
  useFocusForm('New requisition', asked && title !== null);
  const { run, busy, error } = useRun(() => undefined);
  return (
    <Card
      title={`Requisitions${rows.data ? ` (${rows.data.length})` : ''}`}
      actions={
        mayRaise &&
        title === null && (
          <Button variant="secondary" onClick={() => setTitle('')}>
            <Plus className="size-4" aria-hidden /> New requisition
          </Button>
        )
      }
    >
      {title !== null && (
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          aria-label="New requisition"
          onSubmit={(e) => {
            e.preventDefault();
            void run('create', async () => {
              const r = await api.request<Requisition>(
                `/api/tenant/projects/${p.id}/requisitions`,
                {
                  method: 'POST',
                  body: { title: title.trim(), lines: [] },
                },
              );
              await navigate({
                to: '/requisitions/$requisitionId',
                params: { requisitionId: r.id },
              });
            });
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label="What is it for?">
              <Input
                value={title}
                maxLength={300}
                placeholder="e.g. Cement and steel for the first-floor slab"
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <Button type="submit" busy={busy === 'create'} disabled={title.trim().length < 3}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={() => setTitle(null)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {rows.isPending ? (
        <Spinner />
      ) : rows.isError ? (
        <Alert tone="danger">{describeError(rows.error)}</Alert>
      ) : (
        <RequisitionTable rows={rows.data} />
      )}
    </Card>
  );
}
