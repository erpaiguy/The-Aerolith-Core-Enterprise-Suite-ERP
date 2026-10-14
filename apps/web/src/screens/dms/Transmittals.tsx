// Transmittals, RFIs and submittals (docs/wave5-plan.md step 3): a project's registers with overdue in red; a
// transmittal drafted from vault documents, issued, shared through an expiring link and its answer recorded; RFIs
// raised, answered and tied to what came of them; submittals sent for approval through a review.
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
import { useState } from 'react';
import { api } from '../../api/client';
import type { DocVault, ProjectDetail, ProjectSummary } from '../../api/types';
import { describeError } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';

type Tab = 'transmittals' | 'rfis' | 'submittals';
type Call = <T>(path: string, body: object) => Promise<T | null>;

const tone = (s: string) =>
  s === 'responded' || s === 'approved' || s === 'answered' || s === 'closed'
    ? 'success'
    : s === 'rejected' || s === 'returned'
      ? 'danger'
      : s === 'draft'
        ? 'neutral'
        : 'warning';

export function TransmittalsScreen() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  // A register row opens this screen on its project (`?project=`).
  const [projectId, setProjectId] = useProjectParam();
  const [tab, setTab] = useState<Tab>('transmittals');
  const [error, setError] = useState<string | null>(null);
  const call: Call = async <T,>(path: string, body: object) => {
    setError(null);
    try {
      const r = await api.request<T>(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: ['dms', projectId] });
      return r;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Transmittals, RFIs and submittals"
        subtitle="What went out and came back, the questions from site, and what was sent for approval."
        actions={
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} {p.name}
              </option>
            ))}
          </Select>
        }
      />
      <div role="tablist" className="flex gap-1">
        {(
          [
            ['transmittals', 'Transmittals'],
            ['rfis', 'RFIs'],
            ['submittals', 'Submittals'],
          ] as const
        ).map(([k, label]) => (
          <Button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            variant={tab === k ? 'primary' : 'ghost'}
            onClick={() => setTab(k)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {projectId &&
        (tab === 'transmittals' ? (
          <Transmittals key={projectId} projectId={projectId} call={call} />
        ) : tab === 'rfis' ? (
          <Rfis key={projectId} projectId={projectId} call={call} />
        ) : (
          <Submittals key={projectId} projectId={projectId} call={call} />
        ))}
    </div>
  );
}

function useVault(projectId: string) {
  return useQuery({
    queryKey: ['dms', projectId, 'vault'],
    queryFn: () => api.request<DocVault>(`/api/tenant/projects/${projectId}/documents`),
  });
}

// --- transmittals ---

interface TRow {
  id: string;
  number: string;
  subject: string;
  recipient: string;
  purpose: string;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  responseCode: string | null;
  overdue: boolean;
  items: number;
}
interface TDetail {
  id: string;
  number: string;
  subject: string;
  recipient: string;
  purpose: string;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  acknowledgedBy: string | null;
  response: string | null;
  responseCode: string | null;
  responseDocument: string | null;
  respondedBy: string | null;
  items: { id: string; name: string; versionNo: number; latest: number; copies: number }[];
  links: { id: string; expiresAt: string; live: boolean }[];
  events: { kind: string; detail: string; at: string }[];
}

function Transmittals({ projectId, call }: { projectId: string; call: Call }) {
  const list = useQuery({
    queryKey: ['dms', projectId, 'transmittals'],
    queryFn: () => api.request<TRow[]>(`/api/tenant/projects/${projectId}/transmittals`),
  });
  const vault = useVault(projectId);
  const [open, setOpen] = useState<string | null>(null);
  const blank = {
    subject: '',
    recipient: '',
    email: '',
    purpose: 'review',
    responseDays: 7,
    notes: '',
    items: [] as string[],
  };
  const [f, setF] = useState(blank);
  return (
    <>
      <Card title="Transmittals">
        {list.isPending ? (
          <Spinner />
        ) : (list.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">None yet.</p>
        ) : (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>To</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((t) => (
                <tr key={t.id} aria-label={t.number}>
                  <td>
                    <button type="button" className="underline" onClick={() => setOpen(t.id)}>
                      {t.number}
                    </button>{' '}
                    {t.subject}
                  </td>
                  <td>{t.recipient}</td>
                  <td>{t.purpose}</td>
                  <td>
                    <Badge tone={tone(t.status)}>{t.status}</Badge>
                    {t.responseCode && ` ${t.responseCode}`}
                  </td>
                  <td>{t.issuedOn ?? '—'}</td>
                  <td className={t.overdue ? 'text-danger' : ''}>{t.dueOn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <Transmittal key={open} id={open} call={call} />}
      <Card title="New transmittal">
        <form
          aria-label="New transmittal"
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await call<{ id: string }>(`/api/tenant/projects/${projectId}/transmittals`, {
              subject: f.subject,
              recipient: f.recipient,
              email: f.email || null,
              purpose: f.purpose,
              responseDays: f.purpose === 'information' ? null : f.responseDays,
              notes: f.notes,
              items: f.items.map((documentId) => ({ documentId })),
            });
            if (r) {
              setF(blank);
              setOpen(r.id);
            }
          }}
        >
          <Field label="Subject">
            <Input
              value={f.subject}
              onChange={(e) => setF({ ...f, subject: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="Recipient">
            <Input
              value={f.recipient}
              onChange={(e) => setF({ ...f, recipient: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
          </Field>
          <Field label="Purpose">
            <Select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
              <option value="review">For review</option>
              <option value="information">For information</option>
              <option value="construction">For construction</option>
              <option value="record">For record</option>
            </Select>
          </Field>
          {f.purpose !== 'information' && (
            <Field label="Days to respond">
              <Input
                type="number"
                min={1}
                max={90}
                value={f.responseDays}
                onChange={(e) => setF({ ...f, responseDays: Number(e.target.value) })}
              />
            </Field>
          )}
          <Field label="Documents">
            <Select
              multiple
              value={f.items}
              onChange={(e) =>
                setF({ ...f, items: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {(vault.data?.documents ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} (rev {d.versionNo})
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea
                value={f.notes}
                onChange={(e) => setF({ ...f, notes: e.target.value })}
                rows={2}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button type="submit">Save draft</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function Transmittal({ id, call }: { id: string; call: Call }) {
  const q = useQuery({
    queryKey: ['dms', 'transmittal', id],
    queryFn: () => api.request<TDetail>(`/api/tenant/transmittals/${id}`),
  });
  const [link, setLink] = useState<string | null>(null);
  const [rec, setRec] = useState({ by: '', response: '' });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const t = q.data;
  const act = async (path: string, body: object = {}) => {
    const r = await call<TDetail>(`/api/tenant/transmittals/${id}/${path}`, body);
    if (r) await q.refetch();
    return r;
  };
  const live = t.links.find((l) => l.live);
  return (
    <Card title={`${t.number} ${t.subject}`}>
      <p className="text-sm" data-testid="transmittal-status">
        To {t.recipient} · {t.purpose} · <Badge tone={tone(t.status)}>{t.status}</Badge>
        {t.dueOn && ` · response due ${t.dueOn}`}
        {t.acknowledgedBy && ` · received by ${t.acknowledgedBy}`}
      </p>
      <ol className="mt-2 list-decimal pl-5 text-sm">
        {t.items.map((i) => (
          <li key={i.id}>
            {i.name} rev {i.versionNo}
            {i.latest > i.versionNo && (
              <Badge tone="warning">superseded by rev {i.latest}</Badge>
            )} · {i.copies} {i.copies === 1 ? 'copy' : 'copies'}
          </li>
        ))}
      </ol>
      {t.respondedBy && (
        <p className="mt-2 text-sm" data-testid="transmittal-response">
          Answer from {t.respondedBy}
          {t.responseCode && ` (${t.responseCode})`}: {t.response}
          {t.responseDocument && ` · file ${t.responseDocument}`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {t.status === 'draft' && (
          <Button type="button" onClick={() => void act('issue')}>
            Issue
          </Button>
        )}
        {t.status !== 'draft' && t.status !== 'closed' && (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                const r = await call<{ path: string }>(`/api/tenant/transmittals/${id}/link`, {
                  days: 14,
                });
                if (r) {
                  setLink(`${window.location.origin}${r.path}`);
                  await q.refetch();
                }
              }}
            >
              {live ? 'Make a new link' : 'Make a link for the recipient'}
            </Button>
            {live && (
              <Button type="button" variant="ghost" onClick={() => void act('link/revoke')}>
                Withdraw the link
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => void act('close')}>
              Close
            </Button>
          </>
        )}
      </div>
      {link && (
        <div className="mt-2 text-sm">
          <p className="text-fg-muted">
            Send this to the recipient; it is shown once and works for 14 days.
          </p>
          <Input readOnly aria-label="Link for the recipient" value={link} />
        </div>
      )}
      {!link && live && (
        <p className="mt-2 text-xs text-fg-muted">
          A link is live until {new Date(live.expiresAt).toLocaleString('en-IN')}.
        </p>
      )}
      {(t.status === 'issued' || t.status === 'acknowledged') && (
        <form
          aria-label="Record the answer"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act('respond', { by: rec.by, response: rec.response }))
              setRec({ by: '', response: '' });
          }}
        >
          <Field label="Answered by">
            <Input value={rec.by} onChange={(e) => setRec({ ...rec, by: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Their answer">
              <Input
                value={rec.response}
                onChange={(e) => setRec({ ...rec, response: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              Record
            </Button>
          </div>
        </form>
      )}
      {t.events.length > 0 && (
        <ul className="mt-3 text-xs text-fg-muted" aria-label="Link activity">
          {t.events.map((e, i) => (
            <li key={i}>
              {new Date(e.at).toLocaleString('en-IN')} · {e.kind} {e.detail}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- RFIs ---

interface Rfi {
  id: string;
  number: string;
  subject: string;
  question: string;
  document: string | null;
  location: string;
  assignedToId: string;
  assignedTo: string;
  dueOn: string;
  status: string;
  answer: string | null;
  outcome: string;
  revisedDocument: string | null;
  revisedVersionNo: number | null;
  variation: string | null;
  overdue: boolean;
}

function Rfis({ projectId, call }: { projectId: string; call: Call }) {
  const list = useQuery({
    queryKey: ['dms', projectId, 'rfis'],
    queryFn: () => api.request<Rfi[]>(`/api/tenant/projects/${projectId}/rfis`),
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const vault = useVault(projectId);
  const blank = {
    subject: '',
    question: '',
    documentId: '',
    location: '',
    assignedTo: '',
    dueDays: 7,
  };
  const [f, setF] = useState(blank);
  return (
    <Card title="RFIs">
      <ul className="space-y-3 text-sm">
        {(list.data ?? []).map((r) => (
          <RfiItem key={r.id} r={r} call={call} documents={vault.data?.documents ?? []} />
        ))}
        {list.data?.length === 0 && <li className="text-fg-muted">None yet.</li>}
      </ul>
      <form
        aria-label="New RFI"
        className="mt-4 grid gap-3 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await call(`/api/tenant/projects/${projectId}/rfis`, {
              ...f,
              documentId: f.documentId || null,
            })
          )
            setF(blank);
        }}
      >
        <Field label="Subject">
          <Input
            value={f.subject}
            onChange={(e) => setF({ ...f, subject: e.target.value })}
            required
            minLength={3}
          />
        </Field>
        <Field label="Assigned to">
          <Select
            value={f.assignedTo}
            onChange={(e) => setF({ ...f, assignedTo: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(project.data?.team ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Days to answer">
          <Input
            type="number"
            min={0}
            max={90}
            value={f.dueDays}
            onChange={(e) => setF({ ...f, dueDays: Number(e.target.value) })}
          />
        </Field>
        <div className="sm:col-span-3">
          <Field label="Question">
            <Textarea
              value={f.question}
              onChange={(e) => setF({ ...f, question: e.target.value })}
              rows={2}
              required
              minLength={3}
            />
          </Field>
        </div>
        <Field label="Drawing">
          <Select value={f.documentId} onChange={(e) => setF({ ...f, documentId: e.target.value })}>
            <option value="">None</option>
            {(vault.data?.documents ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Raise RFI</Button>
        </div>
      </form>
    </Card>
  );
}

function RfiItem({
  r,
  call,
  documents,
}: {
  r: Rfi;
  call: Call;
  documents: { id: string; name: string; versionNo: number }[];
}) {
  const [answer, setAnswer] = useState('');
  const [revised, setRevised] = useState('');
  return (
    <li aria-label={r.number} className="rounded border border-border p-2">
      <p>
        <span className="font-medium">
          {r.number} {r.subject}
        </span>{' '}
        <Badge tone={tone(r.status)}>{r.status}</Badge>{' '}
        <span className={r.overdue ? 'text-danger' : 'text-fg-muted'}>
          {r.assignedTo}, due {r.dueOn}
        </span>
      </p>
      <p className="whitespace-pre-wrap">{r.question}</p>
      {(r.document || r.location) && (
        <p className="text-xs text-fg-muted">
          {[r.document, r.location].filter(Boolean).join(' · ')}
        </p>
      )}
      {r.answer && <p className="mt-1 border-l-2 border-border pl-2">{r.answer}</p>}
      {r.outcome === 'revision' && (
        <p className="text-xs">
          Revised: {r.revisedDocument} rev {r.revisedVersionNo}
        </p>
      )}
      {r.outcome === 'variation' && <p className="text-xs">Variation {r.variation}</p>}
      {r.status === 'open' && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call(`/api/tenant/rfis/${r.id}/answer`, { answer })) setAnswer('');
          }}
        >
          <Input
            aria-label={`Answer, ${r.number}`}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            required
          />
          <Button type="submit" variant="secondary">
            Answer
          </Button>
        </form>
      )}
      {r.status === 'answered' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Select
            aria-label={`Revised drawing, ${r.number}`}
            value={revised}
            onChange={(e) => setRevised(e.target.value)}
          >
            <option value="">No revised drawing</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} (rev {d.versionNo})
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void call(`/api/tenant/rfis/${r.id}/outcome`, {
                outcome: revised ? 'revision' : 'none',
                documentId: revised || null,
                close: true,
              })
            }
          >
            Close RFI
          </Button>
        </div>
      )}
    </li>
  );
}

// --- submittals ---

interface Sub {
  id: string;
  number: string;
  kind: string;
  title: string;
  review: string;
  status: string;
  withComments: boolean;
  document: string;
  versionNo: number;
  materialMake: string | null;
  materialStatus: string | null;
  submittedOn: string;
  overdue: boolean | null;
}

function Submittals({ projectId, call }: { projectId: string; call: Call }) {
  const list = useQuery({
    queryKey: ['dms', projectId, 'submittals'],
    queryFn: () => api.request<Sub[]>(`/api/tenant/projects/${projectId}/submittals`),
  });
  const workflows = useQuery({
    queryKey: ['dms', projectId, 'workflows'],
    queryFn: () =>
      api.request<{ id: string; name: string }[]>(
        `/api/tenant/review-workflows?projectId=${projectId}`,
      ),
  });
  const vault = useVault(projectId);
  const blank = { kind: 'shop_drawing', title: '', documentId: '', workflowId: '' };
  const [f, setF] = useState(blank);
  return (
    <Card title="Submittals">
      {(list.data ?? []).length === 0 ? (
        <p className="text-sm text-fg-muted">None yet.</p>
      ) : (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Number</th>
              <th>Kind</th>
              <th>Document</th>
              <th>Review</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data!.map((s) => (
              <tr key={s.id} aria-label={s.number}>
                <td>
                  {s.number} {s.title}
                </td>
                <td>{s.kind.replace('_', ' ')}</td>
                <td>
                  {s.document} rev {s.versionNo}
                </td>
                <td className={s.overdue ? 'text-danger' : ''}>{s.review}</td>
                <td>
                  <Badge tone={tone(s.status)}>
                    {s.status === 'approved' && s.withComments
                      ? 'approved with comments'
                      : s.status.replace('_', ' ')}
                  </Badge>
                  {s.materialMake && ` · ${s.materialMake} ${s.materialStatus}`}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New submittal"
        className="mt-3 grid gap-3 sm:grid-cols-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call(`/api/tenant/projects/${projectId}/submittals`, f)) setF(blank);
        }}
      >
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="shop_drawing">Shop drawing</option>
            <option value="method_statement">Method statement</option>
            <option value="material">Material</option>
            <option value="sample">Sample</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Title">
          <Input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            required
            minLength={3}
          />
        </Field>
        <Field label="Document">
          <Select
            value={f.documentId}
            onChange={(e) => setF({ ...f, documentId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(vault.data?.documents ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} (rev {d.versionNo})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Review workflow">
          <Select
            value={f.workflowId}
            onChange={(e) => setF({ ...f, workflowId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(workflows.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit">Submit</Button>
        </div>
      </form>
    </Card>
  );
}
