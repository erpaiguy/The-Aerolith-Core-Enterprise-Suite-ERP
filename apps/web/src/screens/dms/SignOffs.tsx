// Internal sign-off (docs/wave5-plan.md step 5): drawn signatures only. My signature (drawn on a canvas, saved to
// reuse), the sign-offs waiting on me, a project's sign-offs, starting one with signers in order and each one's field
// dragged on the PDF, signing or declining on my turn, and the signed version with its certificate, verified.
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
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { api, saveFile } from '../../api/client';
import type { DocVault, ProjectDetail, ProjectSummary } from '../../api/types';
import { describeError } from '../../lib/format';
import { PdfPage, usePdf, type Box } from './MarkupViewer';

interface Detail {
  id: string;
  number: string;
  title: string;
  document: { id: string; name: string; versionNo: number };
  status: string;
  signedVersionNo: number | null;
  sourceSha256: string;
  signedSha256: string | null;
  signers: {
    id: string;
    position: number;
    name: string;
    page: number;
    box: Box;
    status: string;
    reason: string;
    actedAt: string | null;
  }[];
  myTurn: boolean;
  notice: string;
}

const tone = (s: string) =>
  s === 'signed' ? 'success' : s === 'declined' || s === 'cancelled' ? 'danger' : 'warning';

/** A canvas to draw a signature on with a mouse, a finger or a pen; gives a PNG. */
export function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1a237e';
  }, []);
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };
  return (
    <div className="space-y-2">
      <canvas
        ref={ref}
        width={480}
        height={160}
        aria-label="Signature pad"
        className="w-full max-w-md touch-none rounded border border-dashed border-line bg-white"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          last.current = at(e);
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const p = at(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last.current = p;
          if (!drawn) setDrawn(true);
        }}
        onPointerUp={(e) => {
          last.current = null;
          if (drawn) onChange(e.currentTarget.toDataURL('image/png'));
        }}
      />
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          const c = ref.current!;
          c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
          setDrawn(false);
          onChange(null);
        }}
      >
        Clear
      </Button>
    </div>
  );
}

export function SignOffsScreen() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const mine = useQuery({
    queryKey: ['sign-offs', 'mine'],
    queryFn: () =>
      api.request<
        { id: string; number: string; title: string; project: string; document: string }[]
      >('/api/tenant/sign-offs/mine'),
  });
  const [projectId, setProjectId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Sign-offs"
        subtitle="Documents signed in order with drawn signatures, each with an audit certificate."
        actions={
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setOpen(null);
            }}
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
      {error && <Alert tone="danger">{error}</Alert>}
      <MySignature onError={setError} />
      <Card title="Waiting on my signature">
        {(mine.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing waiting on you.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="signoffs-mine">
            {mine.data!.map((m) => (
              <li key={m.id}>
                <button type="button" className="underline" onClick={() => setOpen(m.id)}>
                  {m.number} {m.title}
                </button>{' '}
                <span className="text-fg-muted">
                  {m.project} · {m.document}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && (
        <SignOff
          key={open}
          id={open}
          onError={setError}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['sign-offs'] })}
        />
      )}
      {projectId && <ProjectSignOffs key={projectId} projectId={projectId} onOpen={setOpen} />}
    </div>
  );
}

function MySignature({ onError }: { onError: (e: string | null) => void }) {
  const q = useQuery({
    queryKey: ['my-signature'],
    queryFn: () => api.request<{ png: string } | null>('/api/tenant/my-signature'),
  });
  const [png, setPng] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  return (
    <Card title="My signature">
      {q.data && !editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <img
            src={q.data.png}
            alt="My saved signature"
            className="h-16 rounded border border-line bg-white"
          />
          <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
            Draw it again
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            Draw your signature once and use it whenever you sign.
          </p>
          <SignaturePad onChange={setPng} />
          <Button
            type="button"
            disabled={!png}
            onClick={async () => {
              onError(null);
              try {
                await api.request('/api/tenant/my-signature', { method: 'POST', body: { png } });
                setEditing(false);
                await q.refetch();
              } catch (err) {
                onError(describeError(err));
              }
            }}
          >
            Save my signature
          </Button>
        </div>
      )}
    </Card>
  );
}

function SignOff({
  id,
  onError,
  onChanged,
}: {
  id: string;
  onError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const q = useQuery({
    queryKey: ['sign-offs', 'one', id],
    queryFn: () => api.request<Detail>(`/api/tenant/sign-offs/${id}`),
  });
  const [drawing, setDrawing] = useState(false);
  const [png, setPng] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState<boolean | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const act = async (path: string, body: object) => {
    onError(null);
    try {
      await api.request(`/api/tenant/sign-offs/${id}/${path}`, { method: 'POST', body });
      await q.refetch();
      onChanged();
    } catch (err) {
      onError(describeError(err));
    }
  };
  return (
    <Card title={`${d.number} ${d.title}`}>
      <p className="text-sm" data-testid="signoff-status">
        {d.document.name} version {d.document.versionNo} ·{' '}
        <Badge tone={tone(d.status)}>{d.status}</Badge>
        {d.signedVersionNo && ` · signed as version ${d.signedVersionNo}`}
      </p>
      <ol className="mt-2 space-y-1 text-sm">
        {d.signers.map((g) => (
          <li key={g.id} aria-label={`Signer ${g.position}`}>
            {g.position}. {g.name}: <Badge tone={tone(g.status)}>{g.status}</Badge>
            {g.actedAt && (
              <span className="text-fg-muted"> {new Date(g.actedAt).toLocaleString('en-IN')}</span>
            )}
            {g.reason && <span className="text-fg-muted"> · {g.reason}</span>}
          </li>
        ))}
      </ol>
      {d.myTurn && (
        <div className="mt-3 space-y-3 rounded border border-line p-3">
          <p className="text-xs text-fg-muted">{d.notice}</p>
          {drawing ? (
            <>
              <SignaturePad onChange={setPng} />
              <Button type="button" disabled={!png} onClick={() => void act('sign', { png })}>
                Sign with this drawing
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void act('sign', { png: null })}>
                Sign with my saved signature
              </Button>
              <Button type="button" variant="secondary" onClick={() => setDrawing(true)}>
                Draw a signature
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Reason to decline">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={reason.trim().length < 3}
              onClick={() => void act('decline', { reason })}
            >
              Decline
            </Button>
          </div>
        </div>
      )}
      {d.status === 'signed' && d.signedVersionNo && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              try {
                const f = await api.download(
                  `/api/tenant/documents/${d.document.id}/file?version=${d.signedVersionNo}`,
                );
                saveFile(f.blob, f.fileName);
              } catch (err) {
                onError(describeError(err));
              }
            }}
          >
            Download the signed copy
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              try {
                const v = await api.request<{ intact: boolean }>(
                  `/api/tenant/sign-offs/${id}/verify`,
                );
                setVerified(v.intact);
              } catch (err) {
                onError(describeError(err));
              }
            }}
          >
            Verify
          </Button>
          {verified !== null && (
            <span data-testid="signoff-verified">
              {verified ? (
                <Badge tone="success">Intact: the file is as it was signed</Badge>
              ) : (
                <Badge tone="danger">Altered since it was signed</Badge>
              )}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function ProjectSignOffs({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (id: string) => void;
}) {
  const list = useQuery({
    queryKey: ['sign-offs', 'project', projectId],
    queryFn: () =>
      api.request<
        {
          id: string;
          number: string;
          title: string;
          document: string;
          versionNo: number;
          status: string;
          waitingOn: string | null;
        }[]
      >(`/api/tenant/projects/${projectId}/sign-offs`),
  });
  return (
    <>
      <Card title="Sign-offs">
        {(list.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">None yet.</p>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Document</th>
                <th>Status</th>
                <th>Waiting on</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((s) => (
                <tr key={s.id} aria-label={s.number}>
                  <td>
                    <button type="button" className="underline" onClick={() => onOpen(s.id)}>
                      {s.number}
                    </button>{' '}
                    {s.title}
                  </td>
                  <td>
                    {s.document} v{s.versionNo}
                  </td>
                  <td>
                    <Badge tone={tone(s.status)}>{s.status}</Badge>
                  </td>
                  <td>{s.waitingOn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NewSignOff
        projectId={projectId}
        onStarted={(id) => {
          void list.refetch();
          onOpen(id);
        }}
      />
    </>
  );
}

function NewSignOff({
  projectId,
  onStarted,
}: {
  projectId: string;
  onStarted: (id: string) => void;
}) {
  const vault = useQuery({
    queryKey: ['sign-offs', 'vault', projectId],
    queryFn: () => api.request<DocVault>(`/api/tenant/projects/${projectId}/documents`),
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const [title, setTitle] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [signers, setSigners] = useState<
    { userId: string; name: string; page: number | null; box: Box | null }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const doc = (vault.data?.documents ?? []).find((d) => d.id === documentId);
  const placing = signers.findIndex((g) => !g.box);
  return (
    <Card title="New sign-off">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Document (PDF)">
          <Select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">Choose…</option>
            {(vault.data?.documents ?? [])
              .filter((d) => d.mime === 'application/pdf')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} (v{d.versionNo})
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Add a signer">
          <Select
            value=""
            onChange={(e) => {
              const m = project.data?.team.find((x) => x.userId === e.target.value);
              if (m && !signers.some((g) => g.userId === m.userId))
                setSigners([
                  ...signers,
                  { userId: m.userId, name: m.displayName, page: null, box: null },
                ]);
            }}
          >
            <option value="">Choose…</option>
            {(project.data?.team ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {signers.length > 0 && (
        <ol className="mt-2 space-y-1 text-sm" aria-label="Signers in order">
          {signers.map((g, i) => (
            <li key={g.userId}>
              {i + 1}. {g.name}{' '}
              <span className="text-fg-muted">
                {g.box
                  ? `field on page ${g.page}`
                  : i === placing
                    ? 'drag the field on the page'
                    : ''}
              </span>{' '}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSigners(signers.filter((x) => x.userId !== g.userId))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}
      {doc && signers.length > 0 && (
        <SignaturePlacer
          documentId={doc.id}
          versionNo={doc.versionNo}
          fields={signers.flatMap((g, i) =>
            g.box && g.page
              ? [{ page: g.page, box: g.box, label: String(i + 1), name: g.name }]
              : [],
          )}
          onBox={
            placing >= 0
              ? (page, box) =>
                  setSigners(signers.map((g, i) => (i === placing ? { ...g, page, box } : g)))
              : null
          }
        />
      )}
      <Button
        type="button"
        className="mt-3"
        disabled={!title.trim() || !documentId || !signers.length || placing >= 0}
        onClick={async () => {
          setError(null);
          try {
            const r = await api.request<{ id: string }>(
              `/api/tenant/projects/${projectId}/sign-offs`,
              {
                method: 'POST',
                body: {
                  title,
                  documentId,
                  signers: signers.map((g) => ({ userId: g.userId, page: g.page, box: g.box })),
                },
              },
            );
            setTitle('');
            setSigners([]);
            onStarted(r.id);
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        Start the sign-off
      </Button>
    </Card>
  );
}

function SignaturePlacer({
  documentId,
  versionNo,
  fields,
  onBox,
}: {
  documentId: string;
  versionNo: number;
  fields: { page: number; box: Box; label: string; name: string }[];
  onBox: ((page: number, box: Box) => void) | null;
}) {
  const pdf = usePdf(documentId, versionNo);
  if (pdf.isPending) return <Spinner label="Opening the document" />;
  if (pdf.isError) return <Alert tone="danger">{describeError(pdf.error)}</Alert>;
  if (!pdf.data) return <p className="text-sm text-fg-muted">Not a PDF.</p>;
  return (
    <div className="mt-3 max-h-[40rem] space-y-3 overflow-auto">
      {Array.from({ length: Math.min(pdf.data.numPages, 30) }, (_, i) => (
        <PdfPage
          key={i + 1}
          doc={pdf.data!}
          n={i + 1}
          marks={fields
            .filter((f) => f.page === i + 1)
            .map((f) => ({
              id: `${f.page}-${f.label}`,
              label: f.label,
              name: `Signature field ${f.label}, ${f.name}`,
              box: f.box,
              done: true,
            }))}
          draft={null}
          active={null}
          onPick={() => {}}
          onBox={onBox ? (b) => onBox(i + 1, b) : null}
        />
      ))}
    </div>
  );
}
