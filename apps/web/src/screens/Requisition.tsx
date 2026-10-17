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
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { ApprovalSteps } from '../approvals/ApprovalTrail';
import { useRun } from '../approvals/model';
import { describeError, formatInr } from '../lib/format';
import {
  REQUISITION_STATUS,
  REQUISITION_TONE,
  budgetLeft,
  type DemandLine,
  type Requisition,
  type RequisitionLine,
} from '../procurement/model';
import { ResourcePicker } from '../procurement/ResourcePicker';
import { formatQty } from '../boq/model';
import { LastRates } from '../procurement/LastRates';
import { RequisitionLines } from '../procurement/RequisitionLines';
import { shortDate } from '../schedule/model';
import { usePermission } from '../session/permissions';

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
          saved={r.lines}
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
      {r.status === 'approved' && <Enquiries r={r} />}
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
  saved,
  draft,
  setDraft,
  total,
  dirty,
  saving,
  onSave,
}: {
  projectId: string;
  /** The lines as saved: they carry the budget for their resources. */
  saved: RequisitionLine[];
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
              <BudgetHint line={l} saved={saved} />
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
          <LastRates
            resourceIds={draft.lines.map((l) => l.resourceId)}
            names={Object.fromEntries(
              draft.lines.filter((l) => l.resourceId).map((l) => [l.resourceId!, l.description]),
            )}
          />
          <DemandAdder
            projectId={projectId}
            onAdd={(found) => {
              const lines = [...draft.lines];
              for (const d of found) {
                const k = lines.findIndex((l) => l.resourceId === d.resourceId);
                if (k >= 0)
                  lines[k] = {
                    ...lines[k]!,
                    qty: String(
                      Math.round((Number(lines[k]!.qty || 0) + Number(d.qty)) * 10_000) / 10_000,
                    ),
                  };
                else
                  lines.push({
                    ...blank,
                    resourceId: d.resourceId,
                    resourceCode: d.code,
                    description: d.name,
                    unit: d.unit,
                    qty: String(Number(d.qty)),
                    rate: d.rate ? String(Number(d.rate)) : '',
                  });
              }
              setDraft({ ...draft, lines });
            }}
          />
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

/** The material budget for a line's resource: what is left after the project's other requisitions. */
function BudgetHint({ line, saved }: { line: LineDraft; saved: RequisitionLine[] }) {
  if (!line.resourceId) return null;
  const s = saved.find((x) => x.resourceId === line.resourceId);
  if (!s) return null;
  if (s.budgetQty === null)
    return s.hasBudget ? (
      <p className="w-full pl-8 text-xs text-warning" data-testid="budget-hint">
        Not in the material budget.
      </p>
    ) : null;
  const b = budgetLeft(s, line.qty || '0')!;
  return (
    <p
      className={`w-full pl-8 text-xs ${b.over ? 'text-danger' : 'text-fg-muted'}`}
      data-testid="budget-hint"
    >
      Budget {formatQty(String(b.budget))} {line.unit}
      {b.elsewhere > 0 && `, ${formatQty(String(b.elsewhere))} in other requisitions`}:{' '}
      {formatQty(String(b.left))} left
      {b.over && ` — this goes ${formatQty(String(Number(line.qty) - b.left))} over`}.
    </p>
  );
}

/** Adds what a quantity of work on a BOQ item takes, or what the next weeks' work takes, by the budget's norms. */
function DemandAdder({
  projectId,
  onAdd,
}: {
  projectId: string;
  onAdd: (lines: DemandLine[]) => void;
}) {
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('');
  const [weeks, setWeeks] = useState('2');
  const [look, setLook] = useState<{ items: number; lines: DemandLine[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { run, busy, error } = useRun(() => undefined);
  return (
    <div className="space-y-3 rounded-md border border-dashed border-line p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="BOQ item">
          <Input
            value={code}
            maxLength={40}
            className="w-24"
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="Work quantity">
          <Input
            inputMode="decimal"
            value={qty}
            className="w-28"
            onChange={(e) => setQty(e.target.value)}
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          busy={busy === 'item'}
          disabled={!code.trim() || !(Number(qty) > 0)}
          onClick={() =>
            void run('item', async () => {
              const r = await api.request<{ lines: DemandLine[] }>(
                `/api/tenant/projects/${projectId}/material-demand/item?code=${encodeURIComponent(code.trim())}&qty=${encodeURIComponent(qty.trim())}`,
              );
              onAdd(r.lines);
              setCode('');
              setQty('');
            })
          }
        >
          <Plus className="size-4" aria-hidden /> Materials for it
        </Button>
        <span className="px-2 pb-2 text-xs text-fg-muted">or</span>
        <div className="w-36">
          <Field label="The next">
            <Select value={weeks} onChange={(e) => setWeeks(e.target.value)}>
              {[1, 2, 3, 4, 6, 8].map((w) => (
                <option key={w} value={w}>
                  {w} week{w === 1 ? '' : 's'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          type="button"
          variant="secondary"
          busy={busy === 'look'}
          onClick={() =>
            void run('look', async () => {
              const r = await api.request<{ items: number; lines: DemandLine[] }>(
                `/api/tenant/projects/${projectId}/material-demand/lookahead?weeks=${weeks}`,
              );
              setLook(r);
              setPicked(
                new Set(r.lines.filter((l) => l.kind === 'material').map((l) => l.resourceId)),
              );
            })
          }
        >
          From the look-ahead
        </Button>
      </div>
      {look && (
        <div className="space-y-2" data-testid="lookahead-demand">
          <p className="text-xs text-fg-muted">
            The work not yet measured on {look.items} BOQ item{look.items === 1 ? '' : 's'} whose
            activities are on or due in the next {weeks} week{weeks === '1' ? '' : 's'}, by the
            budget&apos;s norms.
          </p>
          {look.lines.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Nothing: link BOQ items to the schedule&apos;s activities, and make the material
              budget from the tender.
            </p>
          ) : (
            <ul className="space-y-1 text-sm" aria-label="Needed in the look-ahead">
              {look.lines.map((l) => (
                <li key={l.resourceId}>
                  <label className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.has(l.resourceId)}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(l.resourceId);
                        else n.delete(l.resourceId);
                        setPicked(n);
                      }}
                    />
                    <span className="font-mono text-xs">{l.code}</span> {l.name}:{' '}
                    <b className="tabular-nums">
                      {formatQty(l.qty)} {l.unit}
                    </b>
                    {Number(l.requisitioned) > 0 && (
                      <span className="text-xs text-fg-muted">
                        ({formatQty(l.requisitioned)} already requisitioned)
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={picked.size === 0}
              onClick={() => {
                onAdd(look.lines.filter((l) => picked.has(l.resourceId)));
                setLook(null);
              }}
            >
              <Plus className="size-4" aria-hidden /> Add the ticked ones
            </Button>
            <Button type="button" variant="ghost" onClick={() => setLook(null)}>
              Close
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

/** The enquiries to vendors asking for an approved requisition's lines, and a new one for it. */
function Enquiries({ r }: { r: Requisition }) {
  const navigate = useNavigate();
  const canRfq = usePermission('rfq.edit');
  const { run, busy, error } = useRun(() => undefined);
  return (
    <Card
      title="Enquiries to vendors"
      actions={
        canRfq && (
          <Button
            variant="secondary"
            busy={busy === 'ask'}
            onClick={() =>
              void run('ask', async () => {
                const rfq = await api.request<{ id: string }>(
                  `/api/tenant/projects/${r.project.id}/rfqs`,
                  {
                    method: 'POST',
                    body: {
                      title: `${r.number} · ${r.title}`.slice(0, 200),
                      requisitionIds: [r.id],
                    },
                  },
                );
                await navigate({ to: '/rfqs/$rfqId', params: { rfqId: rfq.id } });
              })
            }
          >
            Ask vendors
          </Button>
        )
      }
    >
      {r.enquiries.length === 0 ? (
        <p className="text-sm text-fg-muted">Not asked for yet.</p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Enquiries for it">
          {r.enquiries.map((q) => (
            <li key={q.id}>
              <Link
                to="/rfqs/$rfqId"
                params={{ rfqId: q.id }}
                className="text-accent hover:underline"
              >
                {q.number}
              </Link>{' '}
              {q.title} <span className="text-xs text-fg-muted">({q.lines} of its lines)</span>
            </li>
          ))}
        </ul>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
