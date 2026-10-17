// Enquiries to vendors and subcontractors (docs/wave1-plan.md step 9): the RFQs of a tender, and one RFQ with its
// lines, the vendors asked, their quotes, the comparative statement, the choice per line, and the chosen rates put
// into the estimate. Vendors cannot sign in: each gets an Excel enquiry the estimator sends from their own email,
// and the filled file comes back in through "Import quote".
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
  Stat,
  Table,
  Textarea,
  cx,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Download, FileText, Paperclip, Plus, Trash2, Upload, X } from 'lucide-react';
import { useDeferredValue, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, saveFile } from '../api/client';
import type {
  DocVault,
  Party,
  QuoteGstMode,
  Resource,
  RfqApplyResult,
  RfqDetail,
  RfqKind,
  RfqLine,
  RfqQuoteImport,
  RfqRound,
  RfqStatus,
  RfqSummary,
  RfqVendor,
  RfqVendorStatus,
} from '../api/types';
import { formatAmount, formatQty, formatRate, type BoqHeader, type BoqRow } from '../boq/model';
import { describeError, formatDate, formatInr } from '../lib/format';
import type { RequisitionRow } from '../procurement/model';
import { useTradeCategories } from './Vendors';
import { usePermission } from '../session/permissions';

export const RFQ_STATUS: Record<RfqStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const STATUS_TONE: Record<RfqStatus, 'neutral' | 'accent' | 'success' | 'danger'> = {
  draft: 'neutral',
  sent: 'accent',
  closed: 'success',
  cancelled: 'danger',
};
const KIND: Record<RfqKind, string> = { work: 'Work', material: 'Materials' };
const VENDOR_STATUS: Record<RfqVendorStatus, string> = {
  invited: 'Not sent',
  sent: 'Sent',
  quoted: 'Quoted',
  declined: 'Declined',
};
const GST_LABEL: Record<QuoteGstMode, (pct: string) => string> = {
  extra: (p) => `+ GST ${trimZeros(p)}%`,
  included: (p) => `incl. GST ${trimZeros(p)}%`,
  exempt: () => 'GST exempt',
};

const trimZeros = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
/** The standard folder for vendors' quotes (apps/api/src/documents/documents.service.ts). */
const QUOTES_FOLDER = '07 Vendor and subcontractor quotes';
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const post = <T,>(url: string, body: object = {}) =>
  api.request<T>(`/api/tenant/${url}`, { method: 'POST', body });

// --- the tender's RFQs ---

/** The RFQs tab on the tender page. */
export function TenderRfqs({ tenderId }: { tenderId: string }) {
  const navigate = useNavigate();
  const canEdit = usePermission('rfq.edit');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', kind: 'work' as RfqKind, dueOn: '', terms: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rfqs = useQuery({
    queryKey: ['rfqs', tenderId],
    queryFn: () => api.request<RfqSummary[]>(`/api/tenant/tenders/${tenderId}/rfqs`),
  });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<RfqDetail>(`tenders/${tenderId}/rfqs`, {
        title: form.title,
        kind: form.kind,
        dueOn: form.dueOn || null,
        terms: form.terms,
      });
      await navigate({ to: '/rfqs/$rfqId', params: { rfqId: r.id } });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Card
      title="Enquiries to vendors (RFQs)"
      actions={
        canEdit &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> New RFQ
          </Button>
        )
      }
    >
      {adding && (
        <form
          onSubmit={(e) => void create(e)}
          className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem_12rem]">
            <Field label="RFQ title" hint="What is being asked for, e.g. Waterproofing package.">
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                minLength={3}
                required
                autoFocus
              />
            </Field>
            <Field label="Asking for">
              <Select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as RfqKind })}
              >
                <option value="work">Work (subcontractors)</option>
                <option value="material">Materials (suppliers)</option>
              </Select>
            </Field>
            <Field label="Quotes due by">
              <Input
                type="date"
                value={form.dueOn}
                onChange={(e) => setForm({ ...form, dueOn: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Terms"
            hint="Printed on the enquiry: payment, delivery, taxes, what the rate includes."
          >
            <Textarea
              rows={2}
              value={form.terms}
              onChange={(e) => setForm({ ...form, terms: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Create RFQ
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {rfqs.isPending ? (
        <Spinner />
      ) : rfqs.isError ? (
        <Alert tone="danger">{describeError(rfqs.error)}</Alert>
      ) : rfqs.data.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No RFQs yet. Ask subcontractors to price BOQ items, or suppliers to quote materials, and
          compare their quotes here.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Title</th>
              <th>For</th>
              <th>Due</th>
              <th>Status</th>
              <th className="text-right">Lines</th>
              <th className="text-right">Quotes</th>
            </tr>
          </thead>
          <tbody>
            {rfqs.data.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap font-mono text-xs">{r.number}</td>
                <td>
                  <Link
                    to="/rfqs/$rfqId"
                    params={{ rfqId: r.id }}
                    className="font-medium text-accent hover:underline"
                  >
                    {r.title}
                  </Link>
                </td>
                <td>{KIND[r.kind]}</td>
                <td className="whitespace-nowrap">{r.dueOn ? formatDate(r.dueOn) : '-'}</td>
                <td>
                  <Badge tone={STATUS_TONE[r.status]}>{RFQ_STATUS[r.status]}</Badge>
                </td>
                <td className="text-right tabular-nums">{r.lines}</td>
                <td className="text-right tabular-nums">
                  {r.quotes} of {r.vendors}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// --- one RFQ ---

/** Runs a change that answers with the RFQ, puts the answer in the cache, and shows any error. */
function useRfqAction(
  rfqId: string,
  tenderId: string | null | undefined,
  projectId?: string | null,
) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, rfqOf?: (r: T) => RfqDetail) => {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      qc.setQueryData(['rfq', rfqId], rfqOf ? rfqOf(out) : (out as unknown as RfqDetail));
      if (tenderId) {
        void qc.invalidateQueries({ queryKey: ['rfqs', tenderId] });
        void qc.invalidateQueries({ queryKey: ['tender', tenderId] });
      }
      if (projectId) {
        void qc.invalidateQueries({ queryKey: ['project-rfqs', projectId] });
        void qc.invalidateQueries({ queryKey: ['requisition'] });
      }
      return out;
    } catch (err) {
      setError(describeError(err));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, error, setError };
}
type Action = ReturnType<typeof useRfqAction>;

export function RfqScreen({ rfqId }: { rfqId: string }) {
  const canEditRfq = usePermission('rfq.edit');
  const rfq = useQuery({
    queryKey: ['rfq', rfqId],
    queryFn: () => api.request<RfqDetail>(`/api/tenant/rfqs/${rfqId}`),
  });
  const action = useRfqAction(rfqId, rfq.data?.tenderId, rfq.data?.projectId);
  const [editing, setEditing] = useState(false);

  if (rfq.isPending) return <Spinner />;
  if (rfq.isError) return <Alert tone="danger">{describeError(rfq.error)}</Alert>;
  const r = rfq.data;
  const open = r.status === 'draft' || r.status === 'sent';
  const canEdit = canEditRfq && open;
  const setStatus = (status: RfqStatus) =>
    void action.run(`status-${status}`, () =>
      post<RfqDetail>(`rfqs/${r.id}`, { rowVersion: r.rowVersion, status }),
    );
  const anySent = r.vendors.some((v) => v.status !== 'invited');

  return (
    <div className="space-y-5">
      {r.tender ? (
        <Link
          to="/tenders/$tenderId"
          params={{ tenderId: r.tender.id }}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> {r.tender.number} · {r.tender.title}
        </Link>
      ) : (
        r.project && (
          <Link
            to="/projects/$projectId"
            params={{ projectId: r.project.id }}
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden /> {r.project.number} · {r.project.name}
          </Link>
        )
      )}
      <PageHeader
        title={r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{r.number}</span>
            <Badge tone={STATUS_TONE[r.status]}>{RFQ_STATUS[r.status]}</Badge>
            <span>{KIND[r.kind]}</span>
            {r.dueOn && <span>Quotes due {formatDate(r.dueOn)}</span>}
            <RfqCategory rfqId={r.id} category={r.category} mayEdit={canEditRfq && open} />
          </span>
        }
        actions={
          canEditRfq && (
            <>
              {open && !editing && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {open && (
                <Button
                  variant="secondary"
                  busy={action.busy === 'status-closed'}
                  onClick={() => setStatus('closed')}
                >
                  Close RFQ
                </Button>
              )}
              {open && (
                <Button
                  variant="ghost"
                  busy={action.busy === 'status-cancelled'}
                  onClick={() => setStatus('cancelled')}
                >
                  Cancel RFQ
                </Button>
              )}
              {!open && (
                <Button
                  variant="secondary"
                  busy={action.busy === `status-${anySent ? 'sent' : 'draft'}`}
                  onClick={() => setStatus(anySent ? 'sent' : 'draft')}
                >
                  Reopen
                </Button>
              )}
            </>
          )
        }
      />
      {action.error && <Alert tone="danger">{action.error}</Alert>}
      {!open && (
        <Alert tone="info">
          This RFQ is {r.status}: nothing on it can change until it is reopened.
          {r.status === 'closed' && ' Chosen rates can still be put into the estimate.'}
        </Alert>
      )}
      {editing ? (
        <EditRfq rfq={r} action={action} onDone={() => setEditing(false)} />
      ) : (
        r.terms && (
          <Card title="Terms">
            <p className="whitespace-pre-wrap text-sm">{r.terms}</p>
          </Card>
        )
      )}
      <Lines rfq={r} canEdit={canEdit} action={action} />
      <Vendors rfq={r} canEdit={canEdit} action={action} />
      {r.rounds.length > 0 && <Negotiation rfq={r} />}
      <Comparative rfq={r} canEdit={canEditRfq && r.status !== 'cancelled'} action={action} />
    </div>
  );
}

function EditRfq({ rfq, action, onDone }: { rfq: RfqDetail; action: Action; onDone: () => void }) {
  const [v, setV] = useState({ title: rfq.title, dueOn: rfq.dueOn ?? '', terms: rfq.terms });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void action
      .run('edit', () =>
        post<RfqDetail>(`rfqs/${rfq.id}`, {
          rowVersion: rfq.rowVersion,
          title: v.title,
          dueOn: v.dueOn || null,
          terms: v.terms,
        }),
      )
      .then((ok) => ok && onDone());
  };
  return (
    <Card title="Edit RFQ">
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="RFQ title">
            <Input
              value={v.title}
              onChange={(e) => setV({ ...v, title: e.target.value })}
              minLength={3}
              required
            />
          </Field>
          <Field label="Quotes due by">
            <Input
              type="date"
              value={v.dueOn}
              onChange={(e) => setV({ ...v, dueOn: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Terms">
          <Textarea
            rows={3}
            value={v.terms}
            onChange={(e) => setV({ ...v, terms: e.target.value })}
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" busy={action.busy === 'edit'}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- lines ---

function Lines({ rfq, canEdit, action }: { rfq: RfqDetail; canEdit: boolean; action: Action }) {
  const [adding, setAdding] = useState<'boq' | 'resources' | 'requisitions' | 'free' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const add = async (key: string, body: object) => {
    setNotice(null);
    const out = await action.run(
      key,
      () => post<{ added: number; rfq: RfqDetail }>(`rfqs/${rfq.id}/lines`, body),
      (x) => x.rfq,
    );
    if (out) {
      setNotice(
        out.added === 0
          ? 'Nothing new to add: those lines are already on the RFQ.'
          : `Added ${out.added} line${out.added === 1 ? '' : 's'}.`,
      );
      setAdding(null);
    }
    return Boolean(out);
  };
  const quoted = new Set(rfq.lines.filter((l) => Object.keys(l.cells).length).map((l) => l.id));

  return (
    <Card
      title={`Lines (${rfq.lines.length})`}
      actions={
        canEdit &&
        adding === null && (
          <div className="flex flex-wrap gap-2">
            {rfq.kind === 'work' ? (
              rfq.tenderId && (
                <Button variant="secondary" onClick={() => setAdding('boq')}>
                  <Plus className="size-4" aria-hidden /> From the BOQ
                </Button>
              )
            ) : (
              <>
                {rfq.projectId && (
                  <Button variant="secondary" onClick={() => setAdding('requisitions')}>
                    <Plus className="size-4" aria-hidden /> From requisitions
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setAdding('resources')}>
                  <Plus className="size-4" aria-hidden /> From resources
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setAdding('free')}>
              <Plus className="size-4" aria-hidden /> Other line
            </Button>
          </div>
        )
      }
    >
      {notice && (
        <div className="mb-3">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {adding === 'requisitions' && rfq.projectId && (
        <RequisitionPicker
          projectId={rfq.projectId}
          busy={action.busy === 'add-req'}
          onAdd={(requisitionIds) => add('add-req', { requisitionIds })}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'boq' && rfq.tenderId && (
        <BoqPicker
          tenderId={rfq.tenderId}
          busy={action.busy === 'add-boq'}
          onAdd={(boqId, nodeIds) => add('add-boq', { boqId, nodeIds })}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'resources' && (
        <ResourcePicker
          busy={action.busy === 'add-res'}
          onAdd={(resourceIds) => add('add-res', { resourceIds })}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'free' && (
        <FreeLine
          busy={action.busy === 'add-free'}
          onAdd={(free) => add('add-free', { free })}
          onCancel={() => setAdding(null)}
        />
      )}
      {rfq.lines.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {rfq.projectId
            ? rfq.kind === 'work'
              ? 'Add the work to be quoted as lines.'
              : 'Add what approved requisitions need, or materials from the resource library.'
            : rfq.kind === 'work'
              ? 'Add BOQ items: picking a section brings every item under it.'
              : 'Add the materials to be quoted from the resource library.'}
        </p>
      ) : (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th className="w-12">No.</th>
              <th>Description</th>
              <th>Unit</th>
              <th className="text-right">Quantity</th>
              <th className="text-right">Our rate</th>
              {canEdit && <th className="w-10" />}
            </tr>
          </thead>
          <tbody aria-label="RFQ lines">
            {rfq.lines.map((l) => (
              <tr key={l.id}>
                <td className="tabular-nums">{l.seq}</td>
                <td>
                  <LineText line={l} />
                </td>
                <td>{l.unit ?? ''}</td>
                <td className="text-right tabular-nums">{formatQty(l.qty)}</td>
                <td className="text-right tabular-nums">{formatRate(l.ourRate)}</td>
                {canEdit && (
                  <td>
                    <button
                      type="button"
                      className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
                      aria-label={`Remove line ${l.seq}`}
                      title={
                        quoted.has(l.id)
                          ? 'Removing it also removes the rates quoted for it'
                          : 'Remove'
                      }
                      disabled={action.busy !== null}
                      onClick={() =>
                        void action.run(`del-${l.id}`, () =>
                          post<RfqDetail>(`rfq-lines/${l.id}/delete`),
                        )
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function LineText({ line }: { line: RfqLine }) {
  return (
    <div className="min-w-0">
      <div className="line-clamp-2" title={line.description}>
        {line.code && <span className="mr-1.5 font-mono text-xs text-fg-muted">{line.code}</span>}
        {line.description}
      </div>
      {line.requisitions && line.requisitions.length > 0 && (
        <div
          className="mt-0.5 text-xs text-fg-subtle"
          data-testid={`line-requisitions-${line.seq}`}
        >
          For{' '}
          {line.requisitions.map((q, i) => (
            <span key={q.requisitionId}>
              {i > 0 && ', '}
              <Link
                to="/requisitions/$requisitionId"
                params={{ requisitionId: q.requisitionId }}
                className="hover:underline"
              >
                {q.number}
              </Link>{' '}
              ({formatQty(q.qty)})
            </span>
          ))}
        </div>
      )}
      {(line.boqName || line.gone) && (
        <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-subtle">
          {line.boqName && <span>BOQ: {line.boqName}</span>}
          {line.gone && <Badge tone="warning">removed from the BOQ</Badge>}
        </div>
      )}
    </div>
  );
}

/** The project's approved requisitions, to ask vendors for what their lines need. */
function RequisitionPicker({
  projectId,
  busy,
  onAdd,
  onCancel,
}: {
  projectId: string;
  busy: boolean;
  onAdd: (ids: string[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const reqs = useQuery({
    queryKey: ['requisitions', 'project', projectId, 'approved'],
    queryFn: () =>
      api.request<RequisitionRow[]>(
        `/api/tenant/requisitions?projectId=${projectId}&status=approved`,
      ),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <div
      className="mb-4 space-y-3 rounded-md border border-line p-3"
      aria-label="Approved requisitions"
      role="group"
    >
      {reqs.isPending ? (
        <Spinner />
      ) : !reqs.data?.length ? (
        <Alert tone="info">No approved requisitions on this project yet.</Alert>
      ) : (
        <ul className="space-y-1 text-sm">
          {reqs.data.map((q) => (
            <li key={q.id}>
              <label className="flex items-center gap-2">
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
                <span className="text-xs text-fg-muted">
                  ({q.lines} line{q.lines === 1 ? '' : 's'}, {formatInr(q.amount)})
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-fg-muted">
        A material asked for in several requisitions becomes one line with their quantities added
        up; lines already asked for here are not added again.
      </p>
      <div className="flex gap-2">
        <Button busy={busy} disabled={picked.size === 0} onClick={() => void onAdd([...picked])}>
          Add their lines
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Sections of a BOQ (two levels) and, by search, its items; ticking a section asks for every item under it. */
function BoqPicker({
  tenderId,
  busy,
  onAdd,
  onCancel,
}: {
  tenderId: string;
  busy: boolean;
  onAdd: (boqId: string, nodeIds: string[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const boqs = useQuery({
    queryKey: ['tender-boqs', tenderId],
    queryFn: () => api.request<BoqHeader[]>(`/api/tenant/tenders/${tenderId}/boqs`),
  });
  const live = boqs.data?.filter((b) => !b.archivedAt) ?? [];
  const [chosenBoq, setBoq] = useState<string>('');
  const boqId = chosenBoq || live[0]?.id || '';
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const outline = useQuery({
    queryKey: ['boq-outline', boqId, 2],
    queryFn: () => api.request<BoqRow[]>(`/api/tenant/boqs/${boqId}/outline?maxDepth=2`),
    enabled: Boolean(boqId),
  });
  const results = useQuery({
    queryKey: ['boq-search', boqId, q],
    queryFn: () =>
      api.request<{ rows: BoqRow[]; hasMore: boolean }>(
        `/api/tenant/boqs/${boqId}/search?limit=100&q=${encodeURIComponent(q)}`,
      ),
    enabled: Boolean(boqId) && q.length >= 2,
    placeholderData: keepPreviousData,
  });
  const rows = q.length >= 2 ? (results.data?.rows ?? []) : (outline.data ?? []);
  const toggle = (row: BoqRow) => {
    const next = new Map(picked);
    if (next.has(row.id)) next.delete(row.id);
    else next.set(row.id, row.code ? `${row.code} ${row.description}` : row.description);
    setPicked(next);
  };

  if (boqs.isPending) return <Spinner />;
  if (live.length === 0)
    return (
      <div className="mb-4">
        <Alert tone="info">This tender has no BOQ to ask from.</Alert>
      </div>
    );
  return (
    <div className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <Field label="BOQ">
          <Select
            value={boqId}
            onChange={(e) => {
              setBoq(e.target.value);
              setPicked(new Map());
            }}
          >
            {live.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Find items" hint="Two letters or more: searches codes and descriptions.">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
      </div>
      <ul
        className="max-h-72 overflow-y-auto rounded-md border border-line bg-surface text-sm"
        aria-label="BOQ lines to ask for"
      >
        {(q.length >= 2 ? results.isPending : outline.isPending) ? (
          <li className="p-3 text-fg-muted">Loading…</li>
        ) : rows.length === 0 ? (
          <li className="p-3 text-fg-muted">
            {q.length >= 2 ? 'Nothing matches.' : 'This BOQ has no sections: search for items.'}
          </li>
        ) : (
          rows
            .filter((row) => row.type !== 'note')
            .map((row) => (
              <li key={row.id} className="border-b border-line last:border-0">
                <label
                  className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-surface-2"
                  style={{
                    paddingLeft: q.length >= 2 ? undefined : `${0.75 + row.depth * 1.25}rem`,
                  }}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(row.id)}
                    onChange={() => toggle(row)}
                  />
                  <span className="min-w-0">
                    {row.code && <span className="mr-1.5 font-mono text-xs">{row.code}</span>}
                    <span className={row.type === 'section' ? 'font-medium' : ''}>
                      {row.description}
                    </span>
                    {row.type === 'section' && (
                      <span className="ml-1.5 text-xs text-fg-muted">(all items under it)</span>
                    )}
                    {row.type === 'item' && row.qty !== null && (
                      <span className="ml-1.5 text-xs text-fg-muted">
                        {formatQty(row.qty)} {row.unit ?? ''}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          busy={busy}
          disabled={picked.size === 0}
          onClick={() =>
            void onAdd(boqId, [...picked.keys()]).then((ok) => ok && setPicked(new Map()))
          }
        >
          Add {picked.size || ''} to the RFQ
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {picked.size > 0 && (
          <span className="min-w-0 truncate text-xs text-fg-muted">
            {[...picked.values()].join('; ')}
          </span>
        )}
      </div>
    </div>
  );
}

function ResourcePicker({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (ids: string[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const params = new URLSearchParams({ limit: '100', offset: '0', active: 'true' });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['resources', params.toString()],
    queryFn: () =>
      api.request<{ items: Resource[]; total: number }>(`/api/tenant/resources?${params}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3">
      <Field
        label="Find resources"
        hint="Materials are what suppliers quote; any resource can be asked."
      >
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      </Field>
      <ul
        className="max-h-72 overflow-y-auto rounded-md border border-line bg-surface text-sm"
        aria-label="Resources to ask for"
      >
        {list.isPending ? (
          <li className="p-3 text-fg-muted">Loading…</li>
        ) : list.isError ? (
          <li className="p-3 text-danger">{describeError(list.error)}</li>
        ) : list.data.items.length === 0 ? (
          <li className="p-3 text-fg-muted">No resources match.</li>
        ) : (
          list.data.items.map((r) => (
            <li key={r.id} className="border-b border-line last:border-0">
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={picked.has(r.id)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    setPicked(next);
                  }}
                />
                <span className="font-mono text-xs">{r.code}</span>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="text-xs text-fg-muted">
                  {r.rate ? `${formatRate(r.rate)} / ${r.unit}` : r.unit}
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          busy={busy}
          disabled={picked.size === 0}
          onClick={() => void onAdd([...picked]).then((ok) => ok && setPicked(new Set()))}
        >
          Add {picked.size || ''} to the RFQ
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FreeLine({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (free: object) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [v, setV] = useState({ code: '', description: '', unit: '', qty: '' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onAdd({
      code: v.code || null,
      description: v.description,
      unit: v.unit || null,
      qty: v.qty.trim() || null,
    });
  };
  return (
    <form
      onSubmit={submit}
      className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3"
    >
      <p className="text-xs text-fg-muted">
        A line that is not in the BOQ or the resource library (it is quoted and compared, but no
        rate goes into the estimate from it).
      </p>
      <Field label="Line description">
        <Textarea
          rows={2}
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
          required
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code">
          <Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
        </Field>
        <Field label="Unit">
          <Input value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} />
        </Field>
        <Field label="Quantity">
          <Input
            inputMode="decimal"
            value={v.qty}
            onChange={(e) => setV({ ...v, qty: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Add line
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- vendors and quotes ---

function Vendors({ rfq, canEdit, action }: { rfq: RfqDetail; canEdit: boolean; action: Action }) {
  const qc = useQueryClient();
  const canSend = usePermission('rfq.edit');
  const [quoting, setQuoting] = useState<string | null>(null);
  const [imported, setImported] = useState<{ vendor: string; out: RfqQuoteImport } | null>(null);
  const fileFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const docFor = useRef<string | null>(null);
  const docInput = useRef<HTMLInputElement>(null);
  // Quote documents are kept in the tender's documents, or the project's (docs/wave2b-plan.md step 8).
  const owner = rfq.tenderId
    ? { path: `tenders/${rfq.tenderId}`, id: rfq.tenderId, name: 'the tender documents' }
    : rfq.projectId
      ? { path: `projects/${rfq.projectId}`, id: rfq.projectId, name: 'the project documents' }
      : null;
  const canAttach = usePermission('documents.edit') && canSend && owner !== null;
  const [attached, setAttached] = useState<string | null>(null);
  const who = rfq.kind === 'work' ? 'subcontractor' : 'supplier';

  /** The vendor's file goes into the vault (the quotes folder when it has one) and is linked here. */
  const attach = async (files: File[]) => {
    const partyId = docFor.current;
    if (!partyId || !owner || files.length === 0) return;
    setAttached(null);
    let where = owner.name;
    const out = await action.run(`attach-${partyId}`, async () => {
      const vault = await api.request<DocVault>(`/api/tenant/${owner.path}/documents`);
      const folder = vault.folders.find((f) => f.name === QUOTES_FOLDER);
      if (folder) where = `“${QUOTES_FOLDER}”`;
      for (const file of files) {
        const { document } = await api.upload<{ document: { id: string } }>(
          `/api/tenant/${owner.path}/documents/upload${folder ? `?folderId=${folder.id}` : ''}`,
          file,
        );
        await post(`documents/${document.id}/links`, {
          kind: 'rfq_vendor',
          targetId: `${rfq.id}/${partyId}`,
        });
      }
      return api.request<RfqDetail>(`/api/tenant/rfqs/${rfq.id}`);
    });
    if (out) {
      setAttached(
        `Attached ${files.length === 1 ? files[0]!.name : `${files.length} files`}, kept in ${where}.`,
      );
      void qc.invalidateQueries({ queryKey: ['documents', owner.id] });
    }
  };
  const openDocument = (id: string) =>
    void action.run(`doc-${id}`, async () => {
      const { blob, fileName } = await api.download(`/api/tenant/documents/${id}/file`);
      saveFile(blob, fileName);
      return rfq;
    });
  const detach = (partyId: string, documentId: string) =>
    void action.run(`detach-${documentId}`, async () => {
      await post(`documents/${documentId}/links/delete`, {
        kind: 'rfq_vendor',
        targetId: `${rfq.id}/${partyId}`,
      });
      return api.request<RfqDetail>(`/api/tenant/rfqs/${rfq.id}`);
    });

  const download = (v: RfqVendor) =>
    void action.run(`pack-${v.partyId}`, async () => {
      const { blob, fileName } = await api.download(
        `/api/tenant/rfqs/${rfq.id}/vendors/${v.partyId}/pack`,
      );
      saveFile(blob, fileName);
      return rfq;
    });
  const importFile = async (file: File) => {
    const partyId = fileFor.current;
    if (!partyId) return;
    setImported(null);
    const out = await action.run(
      `import-${partyId}`,
      () =>
        api.upload<RfqQuoteImport>(
          `/api/tenant/rfqs/${rfq.id}/quotes/import?partyId=${partyId}`,
          file,
        ),
      (x) => x.rfq,
    );
    if (out)
      setImported({ vendor: rfq.vendors.find((v) => v.partyId === partyId)?.name ?? '', out });
  };

  return (
    <Card
      title={`${rfq.kind === 'work' ? 'Subcontractors' : 'Suppliers'} asked (${rfq.vendors.length})`}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx"
        className="sr-only"
        aria-label="Quote workbook"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      <input
        ref={docInput}
        type="file"
        multiple
        className="sr-only"
        aria-label="Quote documents"
        tabIndex={-1}
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          void attach(fs);
        }}
      />
      {attached && (
        <div className="mb-3">
          <Alert tone="success">{attached}</Alert>
        </div>
      )}
      {imported && (
        <div className="mb-3">
          <Alert tone={imported.out.issues.length ? 'warning' : 'success'}>
            Imported {imported.out.lines} rate{imported.out.lines === 1 ? '' : 's'} from{' '}
            {imported.vendor}
            {imported.out.skipped > 0 && `; ${imported.out.skipped} line(s) left unpriced`}.
            {imported.out.issues.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {imported.out.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}
      {rfq.vendors.length === 0 ? (
        <p className="mb-3 text-sm text-fg-muted">
          Add the {who}s to ask. Each gets an Excel enquiry to send from your own email; their
          filled file comes back in through Import quote.
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-line text-sm" aria-label="Vendors">
          {rfq.vendors.map((v) => (
            <li key={v.partyId} className="py-3" aria-label={v.name}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{v.name}</span>{' '}
                  <Badge
                    tone={
                      v.status === 'quoted'
                        ? 'success'
                        : v.status === 'declined'
                          ? 'danger'
                          : v.status === 'sent'
                            ? 'accent'
                            : 'neutral'
                    }
                  >
                    {VENDOR_STATUS[v.status]}
                    {v.status === 'sent' && v.sentOn ? ` ${formatDate(v.sentOn)}` : ''}
                  </Badge>
                  <div className="text-xs text-fg-muted">
                    {[v.email, v.phone].filter(Boolean).join(' · ') ||
                      'No email or phone on record'}
                  </div>
                  {v.quote && (
                    <div className="text-xs text-fg-muted">
                      Quote {v.quote.reference ? `${v.quote.reference}, ` : ''}received{' '}
                      {formatDate(v.quote.receivedOn)}
                      {v.quote.validUntil &&
                        `, valid until ${formatDate(v.quote.validUntil)}`},{' '}
                      {GST_LABEL[v.quote.gstMode](v.quote.gstPct)}
                      {v.quote.source === 'file' &&
                        v.quote.fileName &&
                        ` (from ${v.quote.fileName})`}
                      {v.quote.round > 1 && (
                        <>
                          {' '}
                          <Badge tone="accent">Round {v.quote.round}</Badge>
                        </>
                      )}
                    </div>
                  )}
                  {v.documents.length > 0 && (
                    <ul
                      className="mt-1 flex flex-wrap gap-1.5"
                      aria-label={`Documents of ${v.name}`}
                    >
                      {v.documents.map((d) => (
                        <li
                          key={d.id}
                          className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs"
                        >
                          <FileText className="size-3.5 text-fg-muted" aria-hidden />
                          <button
                            type="button"
                            className="hover:underline"
                            onClick={() => openDocument(d.id)}
                          >
                            {d.name}
                          </button>
                          {canAttach && (
                            <button
                              type="button"
                              className="rounded text-fg-muted hover:text-danger"
                              aria-label={`Unlink ${d.name}`}
                              onClick={() => detach(v.partyId, d.id)}
                            >
                              <X className="size-3.5" aria-hidden />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {canSend && rfq.lines.length > 0 && (
                    <Button
                      variant="secondary"
                      busy={action.busy === `pack-${v.partyId}`}
                      onClick={() => download(v)}
                      aria-label={`Download the enquiry for ${v.name}`}
                    >
                      <Download className="size-4" aria-hidden /> Enquiry
                    </Button>
                  )}
                  {canEdit && v.status === 'invited' && (
                    <Button
                      variant="secondary"
                      busy={action.busy === `sent-${v.partyId}`}
                      onClick={() =>
                        void action.run(`sent-${v.partyId}`, () =>
                          post<RfqDetail>(`rfqs/${rfq.id}/vendors/${v.partyId}`, {
                            status: 'sent',
                          }),
                        )
                      }
                    >
                      Mark sent
                    </Button>
                  )}
                  {canEdit && rfq.lines.length > 0 && (
                    <>
                      <Button
                        variant="secondary"
                        busy={action.busy === `import-${v.partyId}`}
                        aria-label={`Import the quote of ${v.name}`}
                        onClick={() => {
                          fileFor.current = v.partyId;
                          fileInput.current?.click();
                        }}
                      >
                        <Upload className="size-4" aria-hidden /> Import quote
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={`Type the quote of ${v.name}`}
                        onClick={() => setQuoting(quoting === v.partyId ? null : v.partyId)}
                      >
                        {v.quote ? 'Edit quote' : 'Type quote'}
                      </Button>
                    </>
                  )}
                  {canAttach && rfq.status !== 'cancelled' && (
                    <Button
                      variant="secondary"
                      busy={action.busy === `attach-${v.partyId}`}
                      aria-label={`Attach documents of ${v.name}`}
                      onClick={() => {
                        docFor.current = v.partyId;
                        docInput.current?.click();
                      }}
                    >
                      <Paperclip className="size-4" aria-hidden /> Attach
                    </Button>
                  )}
                  {canEdit && v.status !== 'declined' && !v.quote && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void action.run(`declined-${v.partyId}`, () =>
                          post<RfqDetail>(`rfqs/${rfq.id}/vendors/${v.partyId}`, {
                            status: 'declined',
                          }),
                        )
                      }
                    >
                      Declined
                    </Button>
                  )}
                  {canEdit && !v.quote && (
                    <button
                      type="button"
                      className="rounded p-2 text-fg-muted hover:bg-surface-2 hover:text-danger"
                      aria-label={`Remove ${v.name}`}
                      onClick={() =>
                        void action.run(`remove-${v.partyId}`, () =>
                          post<RfqDetail>(`rfqs/${rfq.id}/vendors/${v.partyId}/delete`),
                        )
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
              {quoting === v.partyId && (
                <QuoteForm
                  key={v.quote?.receivedOn ?? 'new'}
                  rfq={rfq}
                  vendor={v}
                  action={action}
                  onDone={() => setQuoting(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && <AddVendor rfq={rfq} action={action} />}
    </Card>
  );
}

function AddVendor({ rfq, action }: { rfq: RfqDetail; action: Action }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const kind = rfq.kind === 'work' ? 'subcontractor' : 'vendor';
  const parties = useQuery({
    queryKey: ['parties', kind],
    queryFn: () => api.request<Party[]>(`/api/tenant/parties?kind=${kind}`),
  });
  const asked = new Set(rfq.vendors.map((v) => v.partyId));
  const known = parties.data?.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action
      .run('vendor', () =>
        post<RfqDetail>(
          `rfqs/${rfq.id}/vendors`,
          known ? { partyId: known.id } : { name: name.trim(), email: email.trim() || null },
        ),
      )
      .then((ok) => {
        if (ok) {
          setName('');
          setEmail('');
          void qc.invalidateQueries({ queryKey: ['parties'] });
        }
      });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <div className="min-w-[14rem] flex-1">
        <Field
          label={rfq.kind === 'work' ? 'Subcontractor' : 'Supplier'}
          hint={known ? 'From your parties.' : 'A new name is added to your parties.'}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            list="rfq-parties"
            autoComplete="off"
          />
        </Field>
      </div>
      <datalist id="rfq-parties">
        {parties.data
          ?.filter((p) => !asked.has(p.id))
          .map((p) => (
            <option key={p.id} value={p.name} />
          ))}
      </datalist>
      {!known && (
        <div className="min-w-[14rem]">
          <Field label="Email (optional)">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
      )}
      <Button
        type="submit"
        variant="secondary"
        busy={action.busy === 'vendor'}
        disabled={name.trim().length < 2}
      >
        <Plus className="size-4" aria-hidden /> Add
      </Button>
    </form>
  );
}

function QuoteForm({
  rfq,
  vendor,
  action,
  onDone,
}: {
  rfq: RfqDetail;
  vendor: RfqVendor;
  action: Action;
  onDone: () => void;
}) {
  const q = vendor.quote;
  const [head, setHead] = useState({
    receivedOn: q?.receivedOn ?? today(),
    validUntil: q?.validUntil ?? '',
    reference: q?.reference ?? '',
    gstMode: q?.gstMode ?? ('extra' as QuoteGstMode),
    gstPct: trimZeros(q?.gstPct ?? '18'),
    terms: q?.terms ?? '',
  });
  const [revised, setRevised] = useState(true);
  const [rates, setRates] = useState<Record<string, { rate: string; remark: string }>>(() =>
    Object.fromEntries(
      rfq.lines.map((l) => {
        const c = l.cells[vendor.partyId];
        return [l.id, { rate: c ? trimZeros(c.rate) : '', remark: c?.remark ?? '' }];
      }),
    ),
  );
  const filled = rfq.lines.filter((l) => rates[l.id]?.rate.trim());
  const save = (e: FormEvent) => {
    e.preventDefault();
    void action
      .run(`quote-${vendor.partyId}`, () =>
        post<RfqDetail>(`rfqs/${rfq.id}/vendors/${vendor.partyId}/quote`, {
          receivedOn: head.receivedOn,
          validUntil: head.validUntil || null,
          reference: head.reference || null,
          gstMode: head.gstMode,
          gstPct: head.gstMode === 'exempt' ? '0' : head.gstPct,
          terms: head.terms,
          newRound: !q || revised,
          lines: filled.map((l) => ({
            lineId: l.id,
            rate: rates[l.id]!.rate.trim(),
            remark: rates[l.id]!.remark.trim(),
          })),
        }),
      )
      .then((ok) => ok && onDone());
  };
  const set = (id: string, patch: Partial<{ rate: string; remark: string }>) =>
    setRates({ ...rates, [id]: { ...rates[id]!, ...patch } });

  return (
    <form
      onSubmit={save}
      className="mt-3 space-y-3 rounded-md border border-line bg-surface-2 p-3"
      aria-label={`Quote of ${vendor.name}`}
    >
      {q && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">What this is</legend>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={revised} onChange={() => setRevised(true)} />A revised
            quote: keep round {q.round} and record this as round {q.round + 1}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!revised} onChange={() => setRevised(false)} />A correction
            to round {q.round}
          </label>
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Field label="Received on">
          <Input
            type="date"
            value={head.receivedOn}
            onChange={(e) => setHead({ ...head, receivedOn: e.target.value })}
            required
          />
        </Field>
        <Field label="Their reference">
          <Input
            value={head.reference}
            onChange={(e) => setHead({ ...head, reference: e.target.value })}
          />
        </Field>
        <Field label="Valid until">
          <Input
            type="date"
            value={head.validUntil}
            onChange={(e) => setHead({ ...head, validUntil: e.target.value })}
          />
        </Field>
        <Field label="GST">
          <Select
            value={head.gstMode}
            onChange={(e) => setHead({ ...head, gstMode: e.target.value as QuoteGstMode })}
          >
            <option value="extra">Extra on top of the rates</option>
            <option value="included">Included in the rates</option>
            <option value="exempt">Exempt</option>
          </Select>
        </Field>
        <Field label="GST rate %">
          <Input
            inputMode="decimal"
            value={head.gstMode === 'exempt' ? '0' : head.gstPct}
            disabled={head.gstMode === 'exempt'}
            onChange={(e) => setHead({ ...head, gstPct: e.target.value })}
          />
        </Field>
      </div>
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th className="w-12">No.</th>
            <th>Description</th>
            <th className="text-right">Quantity</th>
            <th className="w-36">Rate (₹)</th>
            <th>Remark</th>
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((l) => (
            <tr key={l.id}>
              <td className="tabular-nums">{l.seq}</td>
              <td>
                <div className="line-clamp-2">{l.description}</div>
              </td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {formatQty(l.qty)} {l.unit ?? ''}
              </td>
              <td>
                <Input
                  inputMode="decimal"
                  className="text-right"
                  aria-label={`Rate for line ${l.seq}`}
                  value={rates[l.id]?.rate ?? ''}
                  onChange={(e) => set(l.id, { rate: e.target.value })}
                />
              </td>
              <td>
                <Input
                  aria-label={`Remark for line ${l.seq}`}
                  value={rates[l.id]?.remark ?? ''}
                  onChange={(e) => set(l.id, { remark: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Field label="Their terms">
        <Textarea
          rows={2}
          value={head.terms}
          onChange={(e) => setHead({ ...head, terms: e.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          busy={action.busy === `quote-${vendor.partyId}`}
          disabled={filled.length === 0}
        >
          Save quote ({filled.length} of {rfq.lines.length} lines)
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- negotiation ---

/** How each vendor who revised their quote moved, line by line and in total, every rate before GST. */
function Negotiation({ rfq }: { rfq: RfqDetail }) {
  const byVendor = new Map<string, RfqRound[]>();
  for (const r of rfq.rounds) byVendor.set(r.partyId, [...(byVendor.get(r.partyId) ?? []), r]);
  const change = (from: string | undefined, to: string | undefined) => {
    if (!from || !to || Number(from) === 0) return null;
    const pct = ((Number(to) - Number(from)) / Number(from)) * 100;
    return (
      <span className={cx('tabular-nums', pct < 0 ? 'text-success' : pct > 0 ? 'text-danger' : '')}>
        {pct > 0 ? '+' : ''}
        {pct.toFixed(1)} %
      </span>
    );
  };
  return (
    <Card title="Negotiation rounds">
      <p className="mb-3 text-sm text-fg-muted">
        Every revised quote keeps the earlier ones. Rates are before GST, so rounds quoted with GST
        and without compare.
      </p>
      <div className="space-y-5">
        {[...byVendor].map(([partyId, rounds]) => {
          const name = rfq.vendors.find((v) => v.partyId === partyId)?.name ?? '';
          const first = rounds[0]!;
          const last = rounds[rounds.length - 1]!;
          const lines = rfq.lines.filter((l) => rounds.some((r) => r.rates[l.id] !== undefined));
          return (
            <section key={partyId} aria-label={`Rounds of ${name}`}>
              <h3 className="mb-1 text-sm font-medium">{name}</h3>
              <Table minWidth="36rem">
                <thead>
                  <tr>
                    <th className="w-12">No.</th>
                    <th>Description</th>
                    {rounds.map((r) => (
                      <th key={r.round} className="text-right">
                        Round {r.round}
                        <div className="text-xs font-normal text-fg-muted">
                          {formatDate(r.receivedOn)}
                        </div>
                      </th>
                    ))}
                    <th className="text-right">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className="tabular-nums">{l.seq}</td>
                      <td>
                        <div className="line-clamp-1">{l.description}</div>
                      </td>
                      {rounds.map((r) => (
                        <td key={r.round} className="text-right tabular-nums">
                          {r.rates[l.id] !== undefined ? formatRate(r.rates[l.id]!) : '–'}
                        </td>
                      ))}
                      <td className="text-right">{change(first.rates[l.id], last.rates[l.id])}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td />
                    <td>Total before GST</td>
                    {rounds.map((r) => (
                      <td
                        key={r.round}
                        className="text-right tabular-nums"
                        data-testid="round-total"
                      >
                        {formatAmount(r.total)}
                      </td>
                    ))}
                    <td className="text-right">{change(first.total, last.total)}</td>
                  </tr>
                </tbody>
              </Table>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

// --- comparative statement ---

function Comparative({
  rfq,
  canEdit,
  action,
}: {
  rfq: RfqDetail;
  canEdit: boolean;
  action: Action;
}) {
  const [award, setAward] = useState('');
  const [applied, setApplied] = useState<RfqApplyResult | null>(null);
  const quoted = rfq.cs.vendors;
  if (quoted.length === 0)
    return (
      <Card title="Comparative statement">
        <p className="text-sm text-fg-muted">The comparison appears once the first quote is in.</p>
      </Card>
    );
  const t = rfq.cs.totals;
  const choose = (lineId: string, partyId: string | null) =>
    void action.run(
      `pick-${lineId}`,
      () =>
        post<{ chosen: number; rfq: RfqDetail }>(`rfqs/${rfq.id}/select`, {
          lines: [{ lineId, partyId, note: '' }],
        }),
      (x) => x.rfq,
    );
  const apply = async () => {
    setApplied(null);
    const out = await action.run(
      'apply',
      () => post<RfqApplyResult>(`rfqs/${rfq.id}/apply`),
      (x) => x.rfq,
    );
    if (out) setApplied(out);
  };
  const editable = canEdit && rfq.status !== 'closed';

  return (
    <Card
      title="Comparative statement"
      actions={
        <span className="text-xs text-fg-muted">
          Rates before GST: a registered contractor takes the vendor&apos;s GST as input credit.
        </span>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Lowest on every line (L1 split)" value={formatInr(t.splitL1)} />
        <Stat
          label={`Chosen (${t.linesSelected} of ${rfq.lines.length} lines)`}
          value={formatInr(t.selected)}
        />
        <Stat label="Our estimate, same quantities" value={formatInr(t.estimate)} />
        <Stat
          label="Lines nobody quoted"
          value={t.linesUnpriced}
          tone={t.linesUnpriced ? 'warning' : undefined}
        />
      </div>
      {editable && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Button
            variant="secondary"
            busy={action.busy === 'lowest'}
            onClick={() =>
              void action.run(
                'lowest',
                () =>
                  post<{ chosen: number; rfq: RfqDetail }>(`rfqs/${rfq.id}/select`, {
                    lowest: true,
                  }),
                (x) => x.rfq,
              )
            }
          >
            Choose the lowest on every line
          </Button>
          <div className="flex items-end gap-2">
            <Field label="Or give everything to">
              <Select value={award} onChange={(e) => setAward(e.target.value)}>
                <option value="">Choose…</option>
                {quoted.map((v) => (
                  <option key={v.partyId} value={v.partyId}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="secondary"
              disabled={!award}
              busy={action.busy === 'award'}
              onClick={() =>
                void action.run(
                  'award',
                  () =>
                    post<{ chosen: number; rfq: RfqDetail }>(`rfqs/${rfq.id}/select`, { award }),
                  (x) => x.rfq,
                )
              }
            >
              Award
            </Button>
          </div>
        </div>
      )}
      <Table minWidth={`${40 + quoted.length * 11}rem`}>
        <thead>
          <tr>
            <th className="w-12">No.</th>
            <th>Description</th>
            <th className="text-right">Quantity</th>
            <th className="text-right">Our rate</th>
            {quoted.map((v) => (
              <th key={v.partyId} className="text-right">
                <div className="text-fg">{v.name}</div>
                <div className="font-normal">{GST_LABEL[v.gstMode](v.gstPct)}</div>
              </th>
            ))}
            <th>Chosen</th>
          </tr>
        </thead>
        <tbody aria-label="Comparative statement">
          {rfq.lines.map((l) => (
            <tr key={l.id}>
              <td className="align-top tabular-nums">{l.seq}</td>
              <td className="align-top">
                <LineText line={l} />
              </td>
              <td className="whitespace-nowrap text-right align-top tabular-nums">
                {formatQty(l.qty)} {l.unit ?? ''}
              </td>
              <td className="text-right align-top tabular-nums">{formatRate(l.ourRate)}</td>
              {quoted.map((v) => {
                const c = l.cells[v.partyId];
                return (
                  <td
                    key={v.partyId}
                    className={cx(
                      'text-right align-top tabular-nums',
                      c?.rank === 1 && 'bg-success/10',
                      l.selected?.partyId === v.partyId &&
                        'outline outline-2 -outline-offset-2 outline-accent',
                    )}
                    title={
                      c
                        ? [
                            v.gstMode === 'included'
                              ? `As quoted ${formatRate(c.rate)} incl. GST`
                              : '',
                            c.remark,
                          ]
                            .filter(Boolean)
                            .join(' · ') || undefined
                        : undefined
                    }
                  >
                    {c ? (
                      <>
                        <div>
                          {formatRate(c.basic)}
                          {c.rank === 1 && (
                            <span className="ml-1 text-xs font-medium text-success">L1</span>
                          )}
                        </div>
                        {c.amount !== null && (
                          <div className="text-xs text-fg-muted">{formatAmount(c.amount)}</div>
                        )}
                        {c.remark && <div className="text-xs text-fg-subtle">{c.remark}</div>}
                      </>
                    ) : (
                      <span className="text-fg-subtle">-</span>
                    )}
                  </td>
                );
              })}
              <td className="align-top">
                {editable ? (
                  <Select
                    aria-label={`Vendor for line ${l.seq}`}
                    className="min-w-[11rem]"
                    value={l.selected?.partyId ?? ''}
                    disabled={action.busy !== null}
                    onChange={(e) => choose(l.id, e.target.value || null)}
                  >
                    <option value="">None</option>
                    {quoted
                      .filter((v) => l.cells[v.partyId])
                      .map((v) => (
                        <option key={v.partyId} value={v.partyId}>
                          {v.name}
                        </option>
                      ))}
                  </Select>
                ) : (
                  (quoted.find((v) => v.partyId === l.selected?.partyId)?.name ?? '-')
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-line text-sm [&_td]:px-5 [&_td]:py-2 [&_th]:px-5 [&_th]:py-2">
          <TotalRow
            label="Total before GST"
            vendors={quoted}
            cell={(v) => formatAmount(v.basicTotal)}
          />
          <TotalRow label="GST" vendors={quoted} cell={(v) => formatAmount(v.gst)} />
          <TotalRow label="Total with GST" vendors={quoted} cell={(v) => formatAmount(v.total)} />
          <TotalRow
            label="Rank (complete quotes)"
            vendors={quoted}
            cell={(v) =>
              v.complete ? (
                `L${v.rank}`
              ) : (
                <span className="text-warning">
                  {v.linesQuoted} of {rfq.lines.length} lines
                </span>
              )
            }
          />
        </tfoot>
      </Table>
      {rfq.projectId && <MakeOrders rfq={rfq} lines={t.linesSelected} />}
      {canEdit && rfq.tenderId && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              busy={action.busy === 'apply'}
              disabled={t.linesSelected === 0}
              onClick={() => void apply()}
            >
              Put the chosen rates into the estimate
            </Button>
            <span className="text-xs text-fg-muted">
              {rfq.kind === 'work'
                ? 'Each chosen BOQ item gets the rate before GST, as an edit in the BOQ (a frozen version is left alone).'
                : 'Each chosen resource gets a new rate from the quote date, before GST.'}
            </span>
          </div>
          {applied && <Applied result={applied} />}
        </div>
      )}
    </Card>
  );
}

/** A project's enquiry: draft orders for the vendors chosen, one each (docs/wave2b-plan.md step 4). */
function MakeOrders({ rfq, lines }: { rfq: RfqDetail; lines: number }) {
  const qc = useQueryClient();
  const canOrder = usePermission('purchase.edit');
  const [made, setMade] = useState<{ id: string; number: string; vendor: { name: string } }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canOrder) return null;
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.request<{
        orders: { id: string; number: string; vendor: { name: string } }[];
      }>(`/api/tenant/rfqs/${rfq.id}/orders`, { method: 'POST', body: {} });
      setMade(r.orders);
      void qc.invalidateQueries({ queryKey: ['orders'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4" data-testid="rfq-next">
      <div className="flex flex-wrap items-center gap-3">
        <Button busy={busy} disabled={lines === 0} onClick={() => void make()}>
          Make {rfq.kind === 'work' ? 'work' : 'purchase'} orders
        </Button>
        <span className="text-xs text-fg-muted">
          A draft order for each vendor chosen, at the rate before GST and the GST they quoted;
          lines already on an order are left out. A project&apos;s enquiry changes no estimate.
        </span>
      </div>
      {made.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Orders made">
          {made.map((o) => (
            <li key={o.id}>
              <Link
                to="/orders/$orderId"
                params={{ orderId: o.id }}
                className="font-mono text-accent hover:underline"
              >
                {o.number}
              </Link>{' '}
              {o.vendor.name}
            </li>
          ))}
        </ul>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function TotalRow({
  label,
  vendors,
  cell,
}: {
  label: string;
  vendors: RfqDetail['cs']['vendors'];
  cell: (v: RfqDetail['cs']['vendors'][number]) => ReactNode;
}) {
  return (
    <tr>
      <th colSpan={4} className="text-right text-xs font-medium text-fg-muted">
        {label}
      </th>
      {vendors.map((v) => (
        <td key={v.partyId} className="text-right tabular-nums">
          {cell(v)}
        </td>
      ))}
      <td />
    </tr>
  );
}

function Applied({ result }: { result: RfqApplyResult }) {
  const skipped = result.boqs.filter((b) => b.skipped);
  return (
    <Alert tone={skipped.length ? 'warning' : 'success'}>
      <ul className="space-y-0.5">
        {result.boqs.map((b) => (
          <li key={b.boqId}>
            <Link to="/boqs/$boqId" params={{ boqId: b.boqId }} className="font-medium underline">
              {b.name}
            </Link>
            :{' '}
            {b.skipped ??
              `${b.updated} rate${b.updated === 1 ? '' : 's'} changed${b.unchanged ? `, ${b.unchanged} already at the chosen rate` : ''}.`}
          </li>
        ))}
        {result.resources > 0 && (
          <li>
            {result.resources} resource rate{result.resources === 1 ? '' : 's'} added to the rate
            library.
          </li>
        )}
      </ul>
    </Alert>
  );
}

/** The enquiry's trade category (docs/wave8-plan.md step 8e.1). */
function RfqCategory({
  rfqId,
  category,
  mayEdit,
}: {
  rfqId: string;
  category: string | null;
  mayEdit: boolean;
}) {
  const qc = useQueryClient();
  const cats = useTradeCategories();
  const [error, setError] = useState<string | null>(null);
  const name = cats.data?.find((c) => c.key === category)?.name;
  if (!mayEdit) return name ? <span>{name}</span> : null;
  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label="Trade category"
        className="rounded-md border border-line bg-surface px-2 py-0.5 text-sm"
        value={category ?? ''}
        onChange={async (e) => {
          setError(null);
          try {
            await api.request(`/api/tenant/rfqs/${rfqId}/category`, {
              method: 'POST',
              body: { category: e.target.value || null },
            });
            void qc.invalidateQueries({ queryKey: ['rfq', rfqId] });
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <option value="">No trade category</option>
        {(cats.data ?? []).map((c) => (
          <option key={c.key} value={c.key}>
            {c.name}
          </option>
        ))}
      </select>
      {error && <span className="text-danger">{error}</span>}
    </span>
  );
}
