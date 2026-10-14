// Correspondence register (docs/wave7-plan.md step 7d.2): a project's letters in and out, with references, the
// letter each answers, replies owed by a date, and the scan from the project's documents.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Textarea,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';

interface Letter {
  id: string;
  direction: 'in' | 'out';
  number: string;
  letterDate: string;
  party: string;
  reference: string;
  subject: string;
  summary: string;
  status: 'open' | 'closed';
  replyBy: string | null;
  overdue: boolean;
  replyToNumber: string | null;
  answeredBy: string | null;
  document: string | null;
}
interface List {
  letters: Letter[];
  mayWrite: boolean;
}
const today = () => new Date().toISOString().slice(0, 10);

export function LettersScreen({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const key = ['letters', projectId, direction];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<List>(
        `/api/tenant/projects/${projectId}/letters${direction ? `?direction=${direction}` : ''}`,
      ),
  });
  const [adding, setAdding] = useState<null | { replyTo: Letter | null }>(null);
  const [error, setError] = useState<string | null>(null);
  const close = async (id: string) => {
    try {
      await api.request(`/api/tenant/letters/${id}/close`, { method: 'POST', body: {} });
      void qc.invalidateQueries({ queryKey: ['letters', projectId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Correspondence"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Letters"
              value={direction}
              onChange={(e) => setDirection(e.target.value as '' | 'in' | 'out')}
            >
              <option value="">In and out</option>
              <option value="in">Received</option>
              <option value="out">Sent</option>
            </Select>
            {list.data?.mayWrite && !adding ? (
              <Button onClick={() => setAdding({ replyTo: null })}>
                <Plus className="size-4" aria-hidden /> Enter a letter
              </Button>
            ) : null}
          </div>
        }
      />
      {adding ? (
        <NewLetter projectId={projectId} replyTo={adding.replyTo} onClose={() => setAdding(null)} />
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.letters.length === 0 ? (
          <p className="text-sm text-fg-muted">No letter entered yet.</p>
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Letter</th>
                <th>Date</th>
                <th>From / to</th>
                <th>Subject</th>
                <th>Reply</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Correspondence">
              {list.data.letters.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="font-mono text-xs">{l.number}</span>
                    {l.reference ? (
                      <div className="text-xs text-fg-muted">Ref {l.reference}</div>
                    ) : null}
                  </td>
                  <td>{shortDate(l.letterDate)}</td>
                  <td>{l.party}</td>
                  <td>
                    {l.subject}
                    {l.replyToNumber ? (
                      <div className="text-xs text-fg-muted">Answers {l.replyToNumber}</div>
                    ) : null}
                    {l.document ? (
                      <div className="text-xs text-fg-muted">Scan: {l.document}</div>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {l.answeredBy ? (
                      <Badge tone="success">answered by {l.answeredBy}</Badge>
                    ) : l.status === 'closed' ? (
                      <Badge>closed</Badge>
                    ) : l.replyBy ? (
                      <span className={l.overdue ? 'font-medium text-danger' : ''}>
                        by {shortDate(l.replyBy)}
                      </span>
                    ) : (
                      <Badge tone="warning">open</Badge>
                    )}
                  </td>
                  <td className="text-right">
                    {list.data.mayWrite && l.status === 'open' ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => setAdding({ replyTo: l })}>
                          Answer
                        </Button>
                        <Button variant="ghost" onClick={() => void close(l.id)}>
                          Close
                        </Button>
                      </div>
                    ) : null}
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

function NewLetter({
  projectId,
  replyTo,
  onClose,
}: {
  projectId: string;
  replyTo: Letter | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    direction: replyTo ? (replyTo.direction === 'in' ? 'out' : 'in') : 'in',
    letterDate: today(),
    party: replyTo?.party ?? '',
    reference: '',
    subject: replyTo ? `Re: ${replyTo.subject}` : '',
    summary: '',
    replyBy: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Card title={replyTo ? `Answer to ${replyTo.number}` : 'Enter a letter'}>
      <form
        aria-label="Letter"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request(`/api/tenant/projects/${projectId}/letters`, {
              method: 'POST',
              body: {
                ...f,
                replyTo: replyTo?.id ?? null,
                replyBy: f.replyBy || null,
              },
            })
            .then(() => {
              void qc.invalidateQueries({ queryKey: ['letters', projectId] });
              onClose();
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="In or out">
            <Select value={f.direction} onChange={set('direction')}>
              <option value="in">Received</option>
              <option value="out">Sent</option>
            </Select>
          </Field>
          <Field label="Dated">
            <Input type="date" value={f.letterDate} onChange={set('letterDate')} required />
          </Field>
          <Field label={f.direction === 'in' ? 'From' : 'To'}>
            <Input value={f.party} onChange={set('party')} required minLength={2} />
          </Field>
          <Field label="Their reference">
            <Input value={f.reference} onChange={set('reference')} />
          </Field>
        </div>
        <Field label="Subject">
          <Input value={f.subject} onChange={set('subject')} required minLength={3} />
        </Field>
        <Field label="Gist">
          <Textarea rows={2} value={f.summary} onChange={set('summary')} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Reply needed by">
            <Input type="date" value={f.replyBy} onChange={set('replyBy')} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit">Save the letter</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}
