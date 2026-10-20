// A project's documents (docs/wave2b-plan.md step 8): its drawings register, each drawing's revisions (each a version
// of one document, a new one superseding the last), and its vault, kept to its team.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  cx,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, Plus, Printer, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { api, saveFile } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError, formatDate } from '../lib/format';
import { indiaToday } from '../project/daily';
import { VaultDocuments } from './Documents';
import { RevisionControl } from './dms/RevisionControl';

export const DISCIPLINE = {
  architectural: 'Architectural',
  structural: 'Structural',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  fire: 'Fire fighting',
  landscape: 'Landscape',
  interiors: 'Interiors',
  other: 'Other',
} as const;
type Discipline = keyof typeof DISCIPLINE;
const PURPOSE = {
  information: 'For information',
  approval: 'For approval',
  construction: 'Good for construction',
} as const;
type Purpose = keyof typeof PURPOSE;
const PURPOSE_TONE = {
  information: 'neutral',
  approval: 'warning',
  construction: 'success',
} as const;

interface DrawingRow {
  id: string;
  number: string;
  title: string;
  discipline: Discipline;
  documentId: string | null;
  revisions: number;
  current: {
    revision: string;
    purpose: Purpose;
    receivedOn: string;
    receivedFrom: string;
    versionNo: number | null;
  } | null;
}
interface DrawingDetail {
  id: string;
  number: string;
  title: string;
  discipline: Discipline;
  documentId: string | null;
  revisions: {
    id: string;
    revision: string;
    purpose: Purpose;
    receivedFrom: string;
    receivedOn: string;
    note: string;
    versionNo: number | null;
    supersededAt: string | null;
    addedBy: string | null;
    receipts: number;
    acknowledged: number;
    /** The page behind the QR on its controlled copy. */
    checkPath: string;
  }[];
  /** The labels the project's revision series allows next; null when the series is off. */
  next: { preliminary: string | null; construction: string | null } | null;
  mayEdit: boolean;
}

const download = async (documentId: string, versionNo: number | null) => {
  const { blob, fileName } = await api.download(
    `/api/tenant/documents/${documentId}/file${versionNo ? `?version=${versionNo}` : ''}`,
  );
  saveFile(blob, fileName);
};

export function ProjectDocumentsScreen({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<'drawings' | 'files' | 'control'>('drawings');
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  if (project.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  const p = project.data;
  const mayWrite = p.canEdit || p.myRole === 'lead' || p.myRole === 'member';
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {p.number} · {p.name}
      </Link>
      <h1 className="text-xl font-semibold">Documents and drawings</h1>
      <div className="flex gap-1 border-b border-line" role="tablist">
        {(
          [
            ['drawings', 'Drawings register'],
            ['files', 'All documents'],
            ['control', 'Revision control'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === k ? 'border-accent font-medium' : 'border-transparent text-fg-muted',
            )}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'drawings' ? (
        <Drawings projectId={projectId} />
      ) : tab === 'control' ? (
        <RevisionControl projectId={projectId} />
      ) : (
        <VaultDocuments vault={{ kind: 'projects', id: projectId }} mayWrite={mayWrite} />
      )}
    </div>
  );
}

function Drawings({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['drawings', projectId],
    queryFn: () =>
      api.request<{ drawings: DrawingRow[]; mayEdit: boolean }>(
        `/api/tenant/projects/${projectId}/drawings`,
      ),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['drawings', projectId] });
    void qc.invalidateQueries({ queryKey: ['drawing'] });
    void qc.invalidateQueries({ queryKey: ['documents', projectId] });
  };
  if (list.isPending) return <Spinner />;
  if (list.isError) return <Alert tone="danger">{describeError(list.error)}</Alert>;
  const { drawings, mayEdit } = list.data;
  return (
    <div className="space-y-5">
      <Card
        title="Drawings register"
        actions={
          mayEdit &&
          !adding && (
            <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Add a drawing
            </Button>
          )
        }
      >
        {adding && (
          <NewDrawing
            projectId={projectId}
            onDone={(id) => {
              setAdding(false);
              if (id) {
                refresh();
                setOpen(id);
              }
            }}
          />
        )}
        {drawings.length === 0 ? (
          <EmptyState title="No drawings yet.">
            Add each drawing as it is issued; every revision is kept, the latest one in force.
          </EmptyState>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Discipline</th>
                <th>Current revision</th>
                <th>Received</th>
                <th className="text-right">Revisions</th>
              </tr>
            </thead>
            <tbody aria-label="Drawings">
              {drawings.map((d) => (
                <tr key={d.id} className={cx(open === d.id && 'bg-surface-2')}>
                  <td className="whitespace-nowrap font-mono text-sm">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => setOpen(open === d.id ? null : d.id)}
                    >
                      {d.number}
                    </button>
                  </td>
                  <td>{d.title}</td>
                  <td className="text-sm">{DISCIPLINE[d.discipline]}</td>
                  <td>
                    {d.current ? (
                      <span className="flex items-center gap-2">
                        <span className="font-mono">{d.current.revision}</span>
                        <Badge tone={PURPOSE_TONE[d.current.purpose]}>
                          {PURPOSE[d.current.purpose]}
                        </Badge>
                      </span>
                    ) : (
                      <span className="text-sm text-fg-muted">None yet</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-sm">
                    {d.current ? formatDate(d.current.receivedOn) : '-'}
                    {d.current?.receivedFrom && (
                      <div className="text-xs text-fg-muted">{d.current.receivedFrom}</div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{d.revisions}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <DrawingCard key={open} drawingId={open} onChanged={refresh} />}
    </div>
  );
}

function NewDrawing({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (id: string | null) => void;
}) {
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [discipline, setDiscipline] = useState<Discipline>('architectural');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.request<{ id: string }>(`/api/tenant/projects/${projectId}/drawings`, {
        method: 'POST',
        body: { number, title, discipline },
      });
      toast.success(`Drawing ${number.trim()} added`);
      onDone(d.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mb-4 space-y-3 rounded-md border border-line p-3"
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_12rem]">
        <Field label="Drawing number">
          <Input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            required
            maxLength={60}
          />
        </Field>
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={300}
          />
        </Field>
        <Field label="Discipline">
          <Select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
            {Object.entries(DISCIPLINE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Add drawing
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DrawingCard({ drawingId, onChanged }: { drawingId: string; onChanged: () => void }) {
  const d = useQuery({
    queryKey: ['drawing', drawingId],
    queryFn: () => api.request<DrawingDetail>(`/api/tenant/drawings/${drawingId}`),
  });
  const [error, setError] = useState<string | null>(null);
  if (d.isPending) return <Spinner />;
  if (d.isError) return <Alert tone="danger">{describeError(d.error)}</Alert>;
  const x = d.data;
  const get = (versionNo: number | null) =>
    x.documentId &&
    void download(x.documentId, versionNo).catch((err: unknown) => setError(describeError(err)));
  return (
    <Card title={`${x.number} · ${x.title}`}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {x.mayEdit && (
          <NewRevision
            drawingId={drawingId}
            first={!x.revisions.length}
            next={x.next}
            onDone={onChanged}
          />
        )}
        {x.revisions.length === 0 ? (
          <EmptyState title="No revision received yet.">
            {x.mayEdit ? 'Add the first revision above, with its file.' : undefined}
          </EmptyState>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Purpose</th>
                <th>Received</th>
                <th>From</th>
                <th>Note</th>
                <th>Receipts</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="Revisions">
              {x.revisions.map((r) => (
                <tr key={r.id} className={cx(r.supersededAt && 'text-fg-muted')}>
                  <td className="whitespace-nowrap">
                    <span className="font-mono">{r.revision}</span>{' '}
                    {r.supersededAt ? (
                      <Badge>Superseded</Badge>
                    ) : (
                      <Badge tone="accent">Current</Badge>
                    )}
                  </td>
                  <td>
                    <Badge tone={r.supersededAt ? 'neutral' : PURPOSE_TONE[r.purpose]}>
                      {PURPOSE[r.purpose]}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-sm">{formatDate(r.receivedOn)}</td>
                  <td className="text-sm">{r.receivedFrom || '-'}</td>
                  <td className="text-sm">{r.note}</td>
                  <td className="text-sm">
                    {r.receipts ? `${r.acknowledged} of ${r.receipts}` : '-'}
                  </td>
                  <td className="whitespace-nowrap">
                    {r.versionNo && (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`Download revision ${r.revision}`}
                        onClick={() => get(r.versionNo)}
                      >
                        <Download className="size-4" aria-hidden />
                      </Button>
                    )}
                    {r.versionNo && (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`Controlled copy of revision ${r.revision}`}
                        title="The PDF stamped with this revision and a QR to check it is current"
                        onClick={() =>
                          void api
                            .download(`/api/tenant/drawing-revisions/${r.id}/print`)
                            .then((f) => saveFile(f.blob, f.fileName))
                            .catch((err: unknown) => setError(describeError(err)))
                        }
                      >
                        <Printer className="size-4" aria-hidden />
                      </Button>
                    )}
                    <a
                      className="ml-1 text-xs underline"
                      href={r.checkPath}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Check page
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function NewRevision({
  drawingId,
  first,
  next,
  onDone,
}: {
  drawingId: string;
  first: boolean;
  next: DrawingDetail['next'];
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('construction');
  const [receivedFrom, setReceivedFrom] = useState('');
  const [receivedOn, setReceivedOn] = useState(indiaToday());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setError('Choose the drawing file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ revision, purpose, receivedFrom, receivedOn, note });
      await api.upload(`/api/tenant/drawings/${drawingId}/revisions?${q.toString()}`, file);
      toast.success(`Revision ${revision.trim()} added`);
      setRevision('');
      setNote('');
      if (input.current) input.current.value = '';
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-md border border-line p-3">
      <div className="text-sm font-medium">
        {first ? 'The first revision' : 'A new revision (the current one is superseded)'}
      </div>
      {next && (
        <p className="text-xs text-fg-muted" data-testid="next-revision">
          The project's series allows next:{' '}
          {[next.preliminary, next.construction].filter(Boolean).join(' or ') || 'nothing'}.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[7rem_12rem_1fr_10rem]">
        <Field label="Revision">
          <Input
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            required
            maxLength={20}
            placeholder={next?.construction ?? next?.preliminary ?? 'R0'}
          />
        </Field>
        <Field label="Purpose">
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {Object.entries(PURPOSE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Received from">
          <Input
            value={receivedFrom}
            onChange={(e) => setReceivedFrom(e.target.value)}
            maxLength={200}
            placeholder="Architect, consultant"
          />
        </Field>
        <Field label="Received on">
          <Input
            type="date"
            value={receivedOn}
            max={indiaToday()}
            onChange={(e) => setReceivedOn(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <input ref={input} type="file" aria-label="Drawing file" className="text-sm" />
        <Button type="submit" busy={busy}>
          <Upload className="size-4" aria-hidden /> Add revision
        </Button>
      </div>
    </form>
  );
}
