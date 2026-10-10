// A purchase requisition (docs/wave2b-plan.md step 1): what the project asks to be bought, line by line, then sent
// for approval. While it is a draft (or rejected) the team changes it; once submitted it waits on its approvers, and
// the submitter can withdraw it.
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
  Textarea,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Plus, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail, Resource } from '../api/types';
import { ApprovalSteps } from '../approvals/ApprovalTrail';
import { useRun } from '../approvals/model';
import { describeError, formatInr } from '../lib/format';
import { REQUISITION_STATUS, REQUISITION_TONE, type Requisition } from '../procurement/model';
import { RequisitionLines } from '../procurement/RequisitionLines';
import { shortDate } from '../schedule/model';

interface LineDraft {
  resourceId: string | null;
  resourceCode: string | null;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  boqCode: string;
  wbsCode: string;
  neededBy: string;
  notes: string;
}

const toDraft = (r: Requisition) => ({
  title: r.title,
  siteId: r.site?.id ?? '',
  neededBy: r.neededBy ?? '',
  notes: r.notes,
  lines: r.lines.map((l): LineDraft => ({
    resourceId: l.resourceId,
    resourceCode: l.resourceCode,
    description: l.description,
    unit: l.unit,
    qty: l.qty.replace(/\.?0+$/, ''),
    rate: l.rate ? l.rate.replace(/\.?0+$/, '') : '',
    boqCode: l.boqCode ?? '',
    wbsCode: l.wbsCode ?? '',
    neededBy: l.neededBy ?? '',
    notes: l.notes,
  })),
});

/** qty × rate as typed, to two decimals (the server works it out the same way). */
const lineAmount = (l: LineDraft) => {
  const q = Number(l.qty);
  const r = Number(l.rate);
  return l.qty && l.rate && Number.isFinite(q) && Number.isFinite(r)
    ? Math.round(q * r * 100) / 100
    : null;
};

export function RequisitionScreen({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const key = ['requisition', requisitionId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Requisition>(`/api/tenant/requisitions/${requisitionId}`),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  return (
    <RequisitionView
      key={r.data.rowVersion}
      r={r.data}
      onChanged={(next) => {
        if (next) qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['requisitions'] });
        void qc.invalidateQueries({ queryKey: ['inbox'] });
      }}
    />
  );
}

function RequisitionView({
  r,
  onChanged,
}: {
  r: Requisition;
  onChanged: (next?: Requisition) => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(r));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(r)), [draft, r]);
  const { run, busy, error } = useRun(() => onChanged());
  const save = () =>
    run('save', async () =>
      onChanged(
        await api.request<Requisition>(`/api/tenant/requisitions/${r.id}`, {
          method: 'POST',
          body: {
            rowVersion: r.rowVersion,
            title: draft.title,
            siteId: draft.siteId || null,
            neededBy: draft.neededBy || null,
            notes: draft.notes,
            lines: draft.lines.map((l) => ({
              resourceId: l.resourceId,
              description: l.description,
              unit: l.unit,
              qty: l.qty,
              rate: l.rate || null,
              boqCode: l.boqCode || null,
              wbsCode: l.wbsCode || null,
              neededBy: l.neededBy || null,
              notes: l.notes,
            })),
          },
        }),
      ),
    );
  const submit = () =>
    run('submit', () =>
      api.request(`/api/tenant/requisitions/${r.id}/submit`, {
        method: 'POST',
        body: { rowVersion: r.rowVersion },
      }),
    );
  const cancel = () => {
    const reason = window.prompt('Why is it cancelled?');
    if (!reason || reason.trim().length < 3) return;
    void run('cancel', () =>
      api.request(`/api/tenant/requisitions/${r.id}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    );
  };
  const withdraw = () =>
    void run('withdraw', () =>
      api.request(`/api/tenant/approvals/${r.approval!.id}/withdraw`, { method: 'POST', body: {} }),
    );
  const draftTotal = draft.lines.reduce((s, l) => s + (lineAmount(l) ?? 0), 0);
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId: r.project.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {r.project.number} · {r.project.name}
      </Link>
      <PageHeader
        title={r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{r.number}</span>
            <Badge tone={REQUISITION_TONE[r.status]}>{REQUISITION_STATUS[r.status]}</Badge>
            <span>
              {formatInr(r.amount)}
              {r.createdBy && `, raised by ${r.createdBy}`}
            </span>
          </span>
        }
        actions={
          <div className="flex gap-2">
            {r.maySubmit && (
              <Button
                busy={busy === 'submit'}
                disabled={dirty}
                title={dirty ? 'Save your changes first' : undefined}
                onClick={() => void submit()}
              >
                <Send className="size-4" aria-hidden /> Submit for approval
              </Button>
            )}
            {r.mayCancel && (
              <Button variant="ghost" busy={busy === 'cancel'} onClick={cancel}>
                Cancel requisition
              </Button>
            )}
          </div>
        }
      />
      {r.status === 'rejected' && r.statusReason && (
        <Alert tone="warning">
          Rejected: {r.statusReason}. Change it and submit it again, or cancel it.
        </Alert>
      )}
      {r.status === 'cancelled' && r.statusReason && (
        <Alert tone="info">Cancelled: {r.statusReason}</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {r.mayEdit ? (
        <Editor
          projectId={r.project.id}
          draft={draft}
          setDraft={setDraft}
          total={draftTotal}
          dirty={dirty}
          saving={busy === 'save'}
          onSave={() => void save()}
        />
      ) : (
        <Card>
          <dl className="mb-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {r.site && (
              <>
                <dt className="text-fg-muted">Site</dt>
                <dd>{r.site.name}</dd>
              </>
            )}
            {r.neededBy && (
              <>
                <dt className="text-fg-muted">Needed by</dt>
                <dd>{shortDate(r.neededBy)}</dd>
              </>
            )}
            {r.notes && (
              <>
                <dt className="text-fg-muted">Notes</dt>
                <dd className="whitespace-pre-wrap">{r.notes}</dd>
              </>
            )}
          </dl>
          <RequisitionLines lines={r.lines} total={r.amount} />
        </Card>
      )}
      {r.approval && (
        <Card
          title="Approval"
          actions={
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: r.approval.id }}
              className="text-sm text-accent hover:underline"
            >
              Open the approval
            </Link>
          }
        >
          {r.approval.steps.length ? (
            <ApprovalSteps approval={r.approval} />
          ) : (
            <p className="text-sm text-fg-muted">
              No approval rule applies to this amount: approved when submitted.
            </p>
          )}
          {r.approval.mayWithdraw && (
            <Button
              className="mt-3"
              variant="secondary"
              busy={busy === 'withdraw'}
              onClick={withdraw}
            >
              Withdraw to change it
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}

type Draft = ReturnType<typeof toDraft>;

function Editor({
  projectId,
  draft,
  setDraft,
  total,
  dirty,
  saving,
  onSave,
}: {
  projectId: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
  total: number;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft({ ...draft, lines: draft.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const blank: LineDraft = {
    resourceId: null,
    resourceCode: null,
    description: '',
    unit: '',
    qty: '',
    rate: '',
    boqCode: '',
    wbsCode: '',
    neededBy: '',
    notes: '',
  };
  return (
    <form
      className="space-y-5"
      aria-label="Requisition"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <Input
              value={draft.title}
              maxLength={300}
              required
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Site">
              <Select
                value={draft.siteId}
                onChange={(e) => setDraft({ ...draft, siteId: e.target.value })}
              >
                <option value="">Not said</option>
                {project.data?.sites
                  .filter((s) => s.active || s.id === draft.siteId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Needed by">
              <Input
                type="date"
                value={draft.neededBy}
                onChange={(e) => setDraft({ ...draft, neededBy: e.target.value })}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea
                rows={2}
                value={draft.notes}
                maxLength={4000}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Card>
      <Card title={`What is needed (${draft.lines.length})`}>
        <div className="space-y-3">
          {draft.lines.map((l, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Line ${i + 1}`}
              className="flex flex-wrap items-end gap-2 border-b border-line pb-3"
            >
              <span className="w-6 pb-2 text-sm tabular-nums text-fg-muted">{i + 1}</span>
              <div className="min-w-56 flex-1">
                <Field label="What">
                  <Input
                    value={l.description}
                    maxLength={500}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                  />
                </Field>
                {l.resourceCode && (
                  <span className="text-xs text-fg-muted">From the library: {l.resourceCode}</span>
                )}
              </div>
              <Field label="Unit">
                <Input
                  value={l.unit}
                  maxLength={20}
                  className="w-20"
                  onChange={(e) => setLine(i, { unit: e.target.value })}
                />
              </Field>
              <Field label="Quantity">
                <Input
                  inputMode="decimal"
                  value={l.qty}
                  className="w-24"
                  onChange={(e) => setLine(i, { qty: e.target.value })}
                />
              </Field>
              <Field label="Rate ₹">
                <Input
                  inputMode="decimal"
                  value={l.rate}
                  className="w-24"
                  onChange={(e) => setLine(i, { rate: e.target.value })}
                />
              </Field>
              <Field label="BOQ item">
                <Input
                  value={l.boqCode}
                  maxLength={40}
                  className="w-24"
                  onChange={(e) => setLine(i, { boqCode: e.target.value })}
                />
              </Field>
              <Field label="WBS">
                <Input
                  value={l.wbsCode}
                  maxLength={40}
                  className="w-20"
                  onChange={(e) => setLine(i, { wbsCode: e.target.value })}
                />
              </Field>
              <Field label="Needed by">
                <Input
                  type="date"
                  value={l.neededBy}
                  onChange={(e) => setLine(i, { neededBy: e.target.value })}
                />
              </Field>
              <span className="w-28 pb-2 text-right text-sm tabular-nums">
                {lineAmount(l) === null ? '' : formatInr(String(lineAmount(l)))}
              </span>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove line ${i + 1}`}
                onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, k) => k !== i) })}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <ResourcePicker
              onPick={(res) =>
                setDraft({
                  ...draft,
                  lines: [
                    ...draft.lines,
                    {
                      ...blank,
                      resourceId: res.id,
                      resourceCode: res.code,
                      description: res.name,
                      unit: res.unit,
                      rate: res.rate ? res.rate.replace(/\.?0+$/, '') : '',
                    },
                  ],
                })
              }
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDraft({ ...draft, lines: [...draft.lines, blank] })}
            >
              <Plus className="size-4" aria-hidden /> Line typed in
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <span className="text-sm" data-testid="draft-total">
              Estimated total <b className="tabular-nums">{formatInr(String(total))}</b>
            </span>
            <Button type="submit" busy={saving} disabled={!dirty}>
              Save
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}

/** Finds a material (or any resource) in the rate library and adds it as a line, at its current rate. */
function ResourcePicker({ onPick }: { onPick: (r: Resource) => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState('');
  const found = useQuery({
    queryKey: ['resource-search', q],
    queryFn: () =>
      api.request<{ items: Resource[] }>(
        `/api/tenant/resources?q=${encodeURIComponent(q)}&limit=20`,
      ),
    enabled: q.trim().length >= 2,
  });
  const items = found.data?.items ?? [];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Find in the rate library">
        <Input
          value={q}
          placeholder="Code or name"
          className="w-48"
          onChange={(e) => {
            setQ(e.target.value);
            setChosen('');
          }}
        />
      </Field>
      <div className="w-72">
        <Field label="Resource">
          <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">
              {q.trim().length < 2 ? 'Type to find…' : `${items.length} found`}
            </option>
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name} ({r.unit}){r.rate ? ` ₹${Number(r.rate)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={!chosen}
        onClick={() => {
          const r = items.find((x) => x.id === chosen);
          if (r) onPick(r);
          setChosen('');
          setQ('');
        }}
      >
        <Plus className="size-4" aria-hidden /> Add
      </Button>
    </div>
  );
}
