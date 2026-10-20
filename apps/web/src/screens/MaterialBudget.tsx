// One revision of a project's material budget (docs/wave2b-plan.md step 2): each resource's quantity and rate, against
// the revision before it and what the project's requisitions already take; changed and submitted while it is being
// worked on, kept as it was once in force or replaced.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Table,
  Textarea,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { ApprovalSteps } from '../approvals/ApprovalTrail';
import { useRun, type Approval } from '../approvals/model';
import { formatQty, formatRate } from '../boq/model';
import { describeError, formatDateTime, formatInr } from '../lib/format';
import { ResourcePicker } from '../procurement/ResourcePicker';

export type BudgetStatus =
  'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded' | 'discarded';
export const BUDGET_STATUS: Record<BudgetStatus, string> = {
  draft: 'Being worked on',
  submitted: 'Waiting for approval',
  approved: 'In force',
  rejected: 'Rejected',
  superseded: 'Replaced',
  discarded: 'Discarded',
};
export const BUDGET_TONE: Record<BudgetStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
  discarded: 'neutral',
};
const KIND_LABEL: Record<string, string> = {
  material: 'Materials',
  labour: 'Labour',
  equipment: 'Equipment',
  subcontract: 'Subcontract',
  other: 'Other',
};

interface BudgetLine {
  resourceId: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
  qty: string;
  rate: string | null;
  amount: string | null;
  note: string;
  prevQty: string | null;
  prevAmount: string | null;
  requisitioned: string;
}

interface Budget {
  id: string;
  projectId: string;
  project: { id: string; number: string; name: string };
  revision: number;
  status: BudgetStatus;
  statusReason: string | null;
  reason: string;
  source: 'tender' | 'blank' | 'revision';
  basis: { items?: number; changedItems?: number };
  basedOn: { id: string; revision: number } | null;
  total: string;
  createdBy: string | null;
  createdAt: string;
  approvedAt: string | null;
  rowVersion: number;
  lines: BudgetLine[];
  approval: Approval | null;
  mayEdit: boolean;
  maySubmit: boolean;
  mayDiscard: boolean;
}

interface DraftLine {
  resourceId: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
  qty: string;
  rate: string;
  note: string;
}

const trim = (v: string | null) =>
  v === null ? '' : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const toDraft = (b: Budget) => ({
  reason: b.reason,
  lines: b.lines
    .filter((l) => l.amount !== null || Number(l.qty) > 0 || l.rate !== null)
    .map((l): DraftLine => ({
      resourceId: l.resourceId,
      code: l.code,
      name: l.name,
      kind: l.kind,
      unit: l.unit,
      qty: trim(l.qty),
      rate: trim(l.rate),
      note: l.note,
    })),
});

export function MaterialBudgetScreen({ budgetId }: { budgetId: string }) {
  const qc = useQueryClient();
  const key = ['material-budget', budgetId];
  const b = useQuery({
    queryKey: key,
    queryFn: () => api.request<Budget>(`/api/tenant/material-budgets/${budgetId}`),
  });
  if (b.isPending) return <Spinner />;
  if (b.isError) return <Alert tone="danger">{describeError(b.error)}</Alert>;
  return (
    <BudgetView
      key={b.data.rowVersion}
      b={b.data}
      onChanged={(next) => {
        if (next) qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['material-budget-overview', b.data.projectId] });
        void qc.invalidateQueries({ queryKey: ['inbox'] });
      }}
    />
  );
}

function BudgetView({ b, onChanged }: { b: Budget; onChanged: (next?: Budget) => void }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [draft, setDraft] = useState(() => toDraft(b));
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(b)), [draft, b]);
  const { run, busy, error } = useRun(() => onChanged());
  const prev = useMemo(() => new Map(b.lines.map((l) => [l.resourceId, l])), [b.lines]);
  const draftTotal = draft.lines.reduce(
    (s, l) => s + (l.qty && l.rate ? Math.round(Number(l.qty) * Number(l.rate) * 100) / 100 : 0),
    0,
  );
  const save = () =>
    run('save', async () =>
      onChanged(
        await api.request<Budget>(`/api/tenant/material-budgets/${b.id}`, {
          method: 'POST',
          body: {
            rowVersion: b.rowVersion,
            reason: draft.reason,
            lines: draft.lines.map((l) => ({
              resourceId: l.resourceId,
              qty: l.qty || '0',
              rate: l.rate || null,
              note: l.note,
            })),
          },
        }),
      ),
    ).then((ok) => ok && toast.success(`Revision ${b.revision} saved`));
  const isInForce = b.status === 'approved';
  const groups = Object.entries(
    (b.mayEdit ? draft.lines : b.lines).reduce<Record<string, (DraftLine | BudgetLine)[]>>(
      (g, l) => ({ ...g, [l.kind]: [...(g[l.kind] ?? []), l] }),
      {},
    ),
  );
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId: b.project.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {b.project.number} · {b.project.name}
      </Link>
      <PageHeader
        title={`Material budget, revision ${b.revision}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={BUDGET_TONE[b.status]}>{BUDGET_STATUS[b.status]}</Badge>
            <span data-testid="budget-total">{formatInr(b.total)}</span>
            <span>
              {b.source === 'tender'
                ? 'from the tender estimate'
                : b.source === 'blank'
                  ? 'started empty'
                  : `revising revision ${b.basedOn?.revision ?? ''}`}
              {b.createdBy && `, by ${b.createdBy}`}
            </span>
            {b.approvedAt && <span>in force from {formatDateTime(b.approvedAt)}</span>}
          </span>
        }
        actions={
          <div className="flex gap-2">
            {b.maySubmit && (
              <Button
                busy={busy === 'submit'}
                disabled={dirty}
                title={dirty ? 'Save your changes first' : undefined}
                onClick={() =>
                  void run('submit', () =>
                    api.request(`/api/tenant/material-budgets/${b.id}/submit`, {
                      method: 'POST',
                      body: { rowVersion: b.rowVersion },
                    }),
                  ).then((ok) => ok && toast.success(`Revision ${b.revision} put up for approval`))
                }
              >
                <Send className="size-4" aria-hidden /> Submit for approval
              </Button>
            )}
            {b.mayDiscard && (
              <Button
                variant="ghost"
                busy={busy === 'discard'}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Discard revision ${b.revision}?`,
                      body: 'Its quantities and rates are thrown away; the revision in force stays as it is.',
                      confirmLabel: 'Discard the revision',
                      tone: 'danger',
                    }))
                  )
                    return;
                  await run('discard', async () => {
                    await api.request(`/api/tenant/material-budgets/${b.id}/discard`, {
                      method: 'POST',
                    });
                    toast.success(`Revision ${b.revision} discarded`);
                    await navigate({
                      to: '/projects/$projectId',
                      params: { projectId: b.project.id },
                    });
                  });
                }}
              >
                Discard revision
              </Button>
            )}
          </div>
        }
      />
      {(b.basis.changedItems ?? 0) > 0 && b.source === 'tender' && (
        <Alert tone="warning">
          {b.basis.changedItems} of the {b.basis.items} BOQ items took their quantities from a rate
          analysis changed after the tender was frozen, so they may not be what was bid. Check them,
          and revise the budget if needed.
        </Alert>
      )}
      {b.status === 'rejected' && b.statusReason && (
        <Alert tone="warning">Rejected: {b.statusReason}. Change it and submit it again.</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {b.mayEdit ? (
        <Card>
          <Field label="Why this revision">
            <Textarea
              rows={2}
              maxLength={2000}
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            />
          </Field>
        </Card>
      ) : (
        b.reason && (
          <p className="text-sm">
            <span className="text-fg-muted">Why: </span>
            {b.reason}
          </p>
        )
      )}
      {groups.length === 0 && (
        <Card>
          <EmptyState title="Nothing in this budget yet.">
            {b.mayEdit ? 'Add the resources the project needs below.' : null}
          </EmptyState>
        </Card>
      )}
      {groups.map(([kind, lines]) => (
        <Card key={kind} title={KIND_LABEL[kind] ?? kind}>
          <Table minWidth="54rem">
            <thead>
              <tr>
                <th>Resource</th>
                <th className="text-right">Quantity</th>
                <th className="text-right">Rate</th>
                <th className="text-right">Amount</th>
                {b.basedOn && <th className="text-right">Revision {b.basedOn.revision}</th>}
                <th className="text-right">Requisitioned</th>
                {b.mayEdit && <th />}
              </tr>
            </thead>
            <tbody aria-label={`Budget: ${KIND_LABEL[kind] ?? kind}`}>
              {lines.map((l) => {
                const p = prev.get(l.resourceId);
                const editing = b.mayEdit;
                const i = draft.lines.findIndex((x) => x.resourceId === l.resourceId);
                const d = editing ? draft.lines[i]! : null;
                const set = (patch: Partial<DraftLine>) =>
                  setDraft({
                    ...draft,
                    lines: draft.lines.map((x, k) => (k === i ? { ...x, ...patch } : x)),
                  });
                const qty = d ? d.qty : (l as BudgetLine).qty;
                const amount = d
                  ? d.qty && d.rate
                    ? String(Math.round(Number(d.qty) * Number(d.rate) * 100) / 100)
                    : null
                  : (l as BudgetLine).amount;
                const removed = !d && (l as BudgetLine).amount === null && Number(qty) === 0;
                const used = Number(p?.requisitioned ?? 0);
                return (
                  <tr key={l.resourceId} className={cx(removed && 'text-fg-subtle line-through')}>
                    <td>
                      <span className="mr-2 font-mono text-xs">{l.code}</span>
                      {l.name}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {d ? (
                        <Input
                          aria-label={`Quantity of ${l.code}`}
                          inputMode="decimal"
                          value={d.qty}
                          className="w-28 text-right"
                          onChange={(e) => set({ qty: e.target.value })}
                        />
                      ) : (
                        <>
                          {formatQty(qty)} {l.unit}
                        </>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {d ? (
                        <Input
                          aria-label={`Rate of ${l.code}`}
                          inputMode="decimal"
                          value={d.rate}
                          className="w-28 text-right"
                          onChange={(e) => set({ rate: e.target.value })}
                        />
                      ) : (
                        formatRate((l as BudgetLine).rate)
                      )}
                    </td>
                    <td className="text-right tabular-nums">{amount ? formatInr(amount) : '-'}</td>
                    {b.basedOn && (
                      <td className="text-right text-xs tabular-nums text-fg-muted">
                        {p?.prevQty ? `${formatQty(p.prevQty)} ${l.unit}` : 'new'}
                      </td>
                    )}
                    <td
                      className={cx(
                        'text-right tabular-nums',
                        used > Number(qty || 0) && 'font-medium text-danger',
                      )}
                      data-testid={`requisitioned-${l.code}`}
                    >
                      {used > 0 ? `${formatQty(String(used))} ${l.unit}` : ''}
                    </td>
                    {b.mayEdit && (
                      <td className="text-right">
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${l.code}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              lines: draft.lines.filter((x) => x.resourceId !== l.resourceId),
                            })
                          }
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ))}
      {b.mayEdit && (
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ResourcePicker
              onPick={(r) =>
                draft.lines.some((l) => l.resourceId === r.id)
                  ? undefined
                  : setDraft({
                      ...draft,
                      lines: [
                        ...draft.lines,
                        {
                          resourceId: r.id,
                          code: r.code,
                          name: r.name,
                          kind: r.kind,
                          unit: r.unit,
                          qty: '',
                          rate: r.rate ? trim(r.rate) : '',
                          note: '',
                        },
                      ],
                    })
              }
            />
            <div className="flex items-center gap-3">
              <span className="text-sm" data-testid="budget-draft-total">
                Total <b className="tabular-nums">{formatInr(String(draftTotal))}</b>
              </span>
              <Button busy={busy === 'save'} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      )}
      {!isInForce && !b.mayEdit && b.status !== 'submitted' && (
        <p className="text-sm text-fg-muted">This revision is kept as it was.</p>
      )}
      {b.approval && (
        <Card
          title="Approval"
          actions={
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: b.approval.id }}
              className="text-sm text-accent hover:underline"
            >
              Open the approval
            </Link>
          }
        >
          {b.approval.steps.length ? (
            <ApprovalSteps approval={b.approval} />
          ) : (
            <p className="text-sm text-fg-muted">
              No approval rule applies: in force when submitted.
            </p>
          )}
          {b.approval.mayWithdraw && (
            <Button
              className="mt-3"
              variant="secondary"
              busy={busy === 'withdraw'}
              onClick={() =>
                void run('withdraw', () =>
                  api.request(`/api/tenant/approvals/${b.approval!.id}/withdraw`, {
                    method: 'POST',
                    body: {},
                  }),
                ).then((ok) => ok && toast.success('Withdrawn: you can change it again'))
              }
            >
              Withdraw to change it
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
