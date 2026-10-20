// A purchase or work order (docs/wave2b-plan.md step 4): to whom, what, at what rate before GST, the GST added on
// top, delivered where and when, on what terms. A draft (or an amendment, or a rejected revision) is changed here and
// sent for approval; the revision in force is what the supplier works to, printed from this page. After issue: the
// supplier's acknowledgement, amendments, cancelling or closing.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { ApprovalSteps } from '../approvals/ApprovalTrail';
import { useRun } from '../approvals/model';
import { describeError, formatDate } from '../lib/format';
import { OrderLines, rupees } from '../procurement/OrderLines';
import {
  ORDER_KIND,
  ORDER_STATUS,
  ORDER_TONE,
  REVISION_STATUS,
  REVISION_TONE,
  SUPPLY,
  draftTax,
  supplyOf,
  type Order,
  type OrderRevision,
  type OverBudget,
} from '../procurement/orders';
import { OrderReceipts } from '../procurement/OrderReceipts';
import { DeliveryFollowUp } from '../procurement/DeliveryFollowUp';
import { LastRates } from '../procurement/LastRates';
import { WorkOrderSubcontract } from './accounts/Subcontract';
import { ResourcePicker } from '../procurement/ResourcePicker';
import { shortDate } from '../schedule/model';
import { printLink } from '../print/Letterhead';
import { PurchaseFlow } from './shell/FlowStrip';

const trimZeros = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

interface LineDraft {
  resourceId: string | null;
  resourceCode: string | null;
  lineKey: string | null;
  rfqLineId: string | null;
  description: string;
  hsn: string;
  unit: string;
  qty: string;
  rate: string;
  gstPct: string;
}

const toDraft = (r: OrderRevision) => ({
  siteId: r.site?.id ?? '',
  deliverBy: r.deliverBy ?? '',
  paymentTerms: r.paymentTerms,
  deliveryTerms: r.deliveryTerms,
  otherTerms: r.otherTerms,
  reason: r.reason,
  lines: r.lines.map((l): LineDraft => ({
    resourceId: l.resourceId,
    resourceCode: l.resourceCode,
    lineKey: l.lineKey,
    rfqLineId: l.rfqLineId,
    description: l.description,
    hsn: l.hsn ?? '',
    unit: l.unit,
    qty: trimZeros(l.qty),
    rate: trimZeros(l.rate),
    gstPct: trimZeros(l.gstPct),
  })),
});
type Draft = ReturnType<typeof toDraft>;

export function PurchaseOrderScreen({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const key = ['order', orderId];
  const o = useQuery({
    queryKey: key,
    queryFn: () => api.request<Order>(`/api/tenant/orders/${orderId}`),
  });
  if (o.isPending) return <Spinner />;
  if (o.isError) return <Alert tone="danger">{describeError(o.error)}</Alert>;
  return (
    <OrderView
      key={`${o.data.rowVersion}-${o.data.open?.rowVersion ?? 0}`}
      o={o.data}
      onChanged={(next) => {
        if (next) qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: ['orders'] });
        void qc.invalidateQueries({ queryKey: ['inbox'] });
      }}
    />
  );
}

/** The approval's link names a revision: find its order. */
export function OrderOfRevisionScreen({ revisionId }: { revisionId: string }) {
  const o = useQuery({
    queryKey: ['order-of-revision', revisionId],
    queryFn: () => api.request<Order>(`/api/tenant/order-revisions/${revisionId}`),
  });
  if (o.isPending) return <Spinner />;
  if (o.isError) return <Alert tone="danger">{describeError(o.error)}</Alert>;
  return <PurchaseOrderScreen orderId={o.data.id} />;
}

function OrderView({ o, onChanged }: { o: Order; onChanged: (next?: Order) => void }) {
  const { run, busy, error } = useRun(() => onChanged());
  const confirm = useConfirm();
  const kind = ORDER_KIND[o.kind];
  const editing = o.mayEdit ? o.open : null;
  const [draft, setDraft] = useState(() => (editing ? toDraft(editing) : null));
  const dirty = useMemo(
    () => !!editing && JSON.stringify(draft) !== JSON.stringify(toDraft(editing)),
    [draft, editing],
  );
  const call = (k: string, path: string, body: object = {}, done?: string) =>
    void run(k, async () =>
      onChanged(await api.request<Order>(`/api/tenant/${path}`, { method: 'POST', body })),
    ).then((ok) => ok && done && toast.success(done));
  const ask = (question: string, k: string, path: string, done: string) => {
    const reason = window.prompt(question);
    if (!reason || reason.trim().length < 3) return;
    call(k, path, { reason: reason.trim() }, done);
  };
  const shown = editing ?? o.open ?? o.inForce;
  // Beyond the material budget, the order goes up only with a reason (step 8a.4).
  const budget = useQuery({
    queryKey: ['order-budget-check', editing?.id, editing?.rowVersion],
    queryFn: () =>
      api.request<{ over: OverBudget[] }>(
        `/api/tenant/order-revisions/${editing!.id}/budget-check`,
      ),
    enabled: !!editing && !dirty,
  });
  const [overReason, setOverReason] = useState('');
  const over = budget.data?.over ?? [];
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId: o.project.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> {o.project.number} · {o.project.name}
      </Link>
      <PageHeader
        title={`${kind} ${o.number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_TONE[o.status]}>{ORDER_STATUS[o.status]}</Badge>
            <span>{o.vendor.name}</span>
            {o.inForce && <span>{rupees(o.inForce.total)} with GST</span>}
            {o.rfq && (
              <span className="print:hidden">
                from{' '}
                <Link
                  to="/rfqs/$rfqId"
                  params={{ rfqId: o.rfq.id }}
                  className="text-accent hover:underline"
                >
                  {o.rfq.number}
                </Link>
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            {editing && (
              <Button
                busy={busy === 'submit'}
                disabled={dirty || (over.length > 0 && overReason.trim().length < 3)}
                title={
                  dirty
                    ? 'Save your changes first'
                    : over.length && overReason.trim().length < 3
                      ? 'Give the reason for going beyond the budget'
                      : undefined
                }
                onClick={() =>
                  call(
                    'submit',
                    `order-revisions/${editing.id}/submit`,
                    {
                      rowVersion: editing.rowVersion,
                      overBudgetReason: over.length ? overReason.trim() : null,
                    },
                    `${kind} ${o.number} put up for approval`,
                  )
                }
              >
                <Send className="size-4" aria-hidden /> Submit for approval
              </Button>
            )}
            {o.inForce && (
              <Link to="/print/orders/$orderId" params={{ orderId: o.id }} className={printLink}>
                <Printer className="size-4" aria-hidden /> Print
              </Link>
            )}
            {o.mayAmend && (
              <Button
                variant="secondary"
                busy={busy === 'amend'}
                onClick={() =>
                  ask(
                    'Why is the order amended?',
                    'amend',
                    `orders/${o.id}/amend`,
                    `Amendment of ${o.number} started`,
                  )
                }
              >
                Amend
              </Button>
            )}
            {o.mayClose && (
              <Button
                variant="ghost"
                busy={busy === 'close'}
                onClick={() =>
                  ask(
                    'Close the order: why is nothing more expected?',
                    'close',
                    `orders/${o.id}/close`,
                    `${kind} ${o.number} closed`,
                  )
                }
              >
                Close
              </Button>
            )}
            {o.mayCancel && (
              <Button
                variant="ghost"
                busy={busy === 'cancel'}
                onClick={() =>
                  ask(
                    'Why is the order cancelled?',
                    'cancel',
                    `orders/${o.id}/cancel`,
                    `${kind} ${o.number} cancelled`,
                  )
                }
              >
                Cancel order
              </Button>
            )}
          </div>
        }
      />
      <PurchaseFlow
        kind="order"
        id={o.id}
        stamp={`${o.rowVersion}-${o.status}-${o.revisions.length}-${o.receipts.length}`}
      />
      {editing && over.length > 0 && (
        <Alert tone="warning">
          <div className="space-y-2">
            <div>
              Beyond the project's material budget:{' '}
              {over
                .map((x) =>
                  x.notInBudget
                    ? `${x.name} (not in the budget)`
                    : `${x.name} by ${Number(x.overQty).toLocaleString('en-IN')} ${x.unit}`,
                )
                .join('; ')}
              . Say why to put it up: the project's lead can, or it goes to an approver.
            </div>
            <Input
              aria-label="Reason for going beyond the budget"
              placeholder="Reason for going beyond the budget"
              value={overReason}
              maxLength={1000}
              onChange={(e) => setOverReason(e.target.value)}
            />
          </div>
        </Alert>
      )}
      {!editing && shown?.overBudgetReason && (
        <Alert tone="info">
          Put up beyond the material budget (
          {(shown.overBudget ?? []).map((x) => x.name).join(', ')}
          ): {shown.overBudgetReason}
        </Alert>
      )}
      {o.status === 'cancelled' && o.statusReason && (
        <Alert tone="info">Cancelled: {o.statusReason}</Alert>
      )}
      {o.status === 'closed' && o.statusReason && (
        <Alert tone="info">Closed: {o.statusReason}</Alert>
      )}
      {o.open?.status === 'rejected' && o.open.statusReason && (
        <Alert tone="warning">
          Rejected: {o.open.statusReason}. Change it and submit it again
          {o.open.revision > 0 ? ', or discard the amendment.' : ', or cancel the order.'}
        </Alert>
      )}
      {o.open && o.inForce && (
        <Alert tone="info">
          Amendment {o.open.revision} ({REVISION_STATUS[o.open.status].toLowerCase()}): until it is
          approved, revision {o.inForce.revision} stays in force.
          {o.open.reason && ` Why: ${o.open.reason}`}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {o.mayAcknowledge && <Acknowledge o={o} busy={busy === 'ack'} call={call} />}
      {o.acknowledgedOn && (
        <p className="text-sm" data-testid="acknowledged">
          Acknowledged by the supplier on {shortDate(o.acknowledgedOn)}
          {o.acknowledgedRef && ` (${o.acknowledgedRef})`}.
        </p>
      )}
      <Parties o={o} />
      {editing && draft ? (
        <Editor
          o={o}
          r={editing}
          draft={draft}
          setDraft={setDraft}
          dirty={dirty}
          saving={busy === 'save'}
          discarding={busy === 'discard'}
          onSave={() =>
            void run('save', async () =>
              onChanged(
                await api.request<Order>(`/api/tenant/order-revisions/${editing.id}`, {
                  method: 'POST',
                  body: {
                    rowVersion: editing.rowVersion,
                    siteId: draft.siteId || null,
                    deliverBy: draft.deliverBy || null,
                    paymentTerms: draft.paymentTerms,
                    deliveryTerms: draft.deliveryTerms,
                    otherTerms: draft.otherTerms,
                    reason: draft.reason,
                    lines: draft.lines.map((l) => ({
                      resourceId: l.resourceId,
                      lineKey: l.lineKey,
                      rfqLineId: l.rfqLineId,
                      description: l.description,
                      hsn: l.hsn,
                      unit: l.unit,
                      qty: l.qty,
                      rate: l.rate,
                      gstPct: l.gstPct,
                    })),
                  },
                }),
              ),
            ).then((ok) => ok && toast.success(`${kind} ${o.number} saved`))
          }
          onDiscard={async () => {
            if (
              !(await confirm({
                title: `Discard amendment ${editing.revision} of ${o.number}?`,
                body: `Its changes are thrown away; revision ${o.inForce?.revision ?? 0} stays in force.`,
                confirmLabel: 'Discard the amendment',
                tone: 'danger',
              }))
            )
              return;
            call(
              'discard',
              `order-revisions/${editing.id}/discard`,
              {},
              `Amendment ${editing.revision} discarded`,
            );
          }}
        />
      ) : (
        shown && <RevisionView r={shown} />
      )}
      {o.approval && (o.open || o.approval.steps.length > 0) && (
        <Card
          title="Approval"
          className="print:hidden"
          actions={
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: o.approval.id }}
              className="text-sm text-accent hover:underline"
            >
              Open the approval
            </Link>
          }
        >
          {o.approval.steps.length ? (
            <ApprovalSteps approval={o.approval} />
          ) : (
            <p className="text-sm text-fg-muted">
              No approval rule applies to this amount: in force when submitted.
            </p>
          )}
          {o.approval.mayWithdraw && (
            <Button
              className="mt-3"
              variant="secondary"
              busy={busy === 'withdraw'}
              onClick={() =>
                void run('withdraw', () =>
                  api.request(`/api/tenant/approvals/${o.approval!.id}/withdraw`, {
                    method: 'POST',
                    body: {},
                  }),
                ).then((ok) => ok && toast.success(`${o.number} withdrawn to change it`))
              }
            >
              Withdraw to change it
            </Button>
          )}
        </Card>
      )}
      {o.kind === 'purchase' && o.inForce && <OrderReceipts o={o} />}
      {o.kind === 'purchase' && o.inForce && <DeliveryFollowUp orderId={o.id} />}
      {o.kind === 'work' && o.inForce && <WorkOrderSubcontract orderId={o.id} />}
      {o.revisions.length > 1 && (
        <Card title="Revisions" className="print:hidden">
          <ul className="space-y-1 text-sm" aria-label="Order revisions">
            {o.revisions.map((r) => (
              <li key={r.id}>
                Revision {r.revision}{' '}
                <Badge tone={REVISION_TONE[r.status]}>{REVISION_STATUS[r.status]}</Badge>{' '}
                {rupees(r.total)}
                {r.approvedAt && (
                  <span className="text-fg-muted">, approved {formatDate(r.approvedAt)}</span>
                )}
                {r.reason && <span className="text-fg-muted"> · {r.reason}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Buyer and supplier with their GSTINs: what decides the GST, and what a printed order shows. */
function Parties({ o }: { o: Order }) {
  return (
    <Card>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-fg-muted">From</dt>
          <dd className="font-medium">{o.buyer.name}</dd>
          {o.buyer.gstin && <dd className="font-mono text-xs">GSTIN {o.buyer.gstin}</dd>}
          <dd className="text-xs text-fg-muted">
            For {o.project.number} · {o.project.name}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">To</dt>
          <dd className="font-medium">{o.vendor.name}</dd>
          <dd className="font-mono text-xs" data-testid="vendor-gstin">
            {o.vendor.gstin ? `GSTIN ${o.vendor.gstin}` : 'No GSTIN: charges no GST'}
          </dd>
          {o.vendor.address && <dd className="whitespace-pre-wrap text-xs">{o.vendor.address}</dd>}
          {(o.vendor.phone || o.vendor.email) && (
            <dd className="text-xs text-fg-muted">
              {[o.vendor.phone, o.vendor.email].filter(Boolean).join(' · ')}
            </dd>
          )}
        </div>
      </dl>
    </Card>
  );
}

function RevisionView({ r }: { r: OrderRevision }) {
  return (
    <Card
      title={`Revision ${r.revision}`}
      actions={<Badge tone={REVISION_TONE[r.status]}>{REVISION_STATUS[r.status]}</Badge>}
    >
      <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-fg-muted">Deliver to</dt>
        <dd>
          {r.site ? (
            <>
              {r.site.name}
              {r.site.stateCode && ` (state ${r.site.stateCode})`}
              {r.site.address && <span className="block text-xs">{r.site.address}</span>}
            </>
          ) : (
            'Not said'
          )}
        </dd>
        {r.deliverBy && (
          <>
            <dt className="text-fg-muted">By</dt>
            <dd>{shortDate(r.deliverBy)}</dd>
          </>
        )}
        {r.supply && (
          <>
            <dt className="text-fg-muted">GST</dt>
            <dd data-testid="supply">{SUPPLY[r.supply]}</dd>
          </>
        )}
        {r.paymentTerms && (
          <>
            <dt className="text-fg-muted">Payment</dt>
            <dd className="whitespace-pre-wrap">{r.paymentTerms}</dd>
          </>
        )}
        {r.deliveryTerms && (
          <>
            <dt className="text-fg-muted">Delivery</dt>
            <dd className="whitespace-pre-wrap">{r.deliveryTerms}</dd>
          </>
        )}
        {r.otherTerms && (
          <>
            <dt className="text-fg-muted">Other terms</dt>
            <dd className="whitespace-pre-wrap">{r.otherTerms}</dd>
          </>
        )}
      </dl>
      <OrderLines r={r} />
    </Card>
  );
}

function Acknowledge({
  o,
  busy,
  call,
}: {
  o: Order;
  busy: boolean;
  call: (k: string, path: string, body: object, done?: string) => void;
}) {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const [on, setOn] = useState(today);
  const [reference, setReference] = useState('');
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3 print:hidden"
      aria-label="Acknowledgement"
      onSubmit={(e) => {
        e.preventDefault();
        call(
          'ack',
          `orders/${o.id}/acknowledge`,
          { on, reference: reference.trim() },
          `Acknowledgement of ${o.number} recorded`,
        );
      }}
    >
      <p className="w-full text-sm text-fg-muted">
        Issued: record the supplier&apos;s acceptance (letter, email or signed copy) when it comes.
      </p>
      <Field label="Accepted on">
        <Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} />
      </Field>
      <Field label="Their reference">
        <Input value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" busy={busy}>
        Acknowledged
      </Button>
    </form>
  );
}

function Editor({
  o,
  r,
  draft,
  setDraft,
  dirty,
  saving,
  discarding,
  onSave,
  onDiscard,
}: {
  o: Order;
  r: OrderRevision;
  draft: Draft;
  setDraft: (d: Draft) => void;
  dirty: boolean;
  saving: boolean;
  discarding: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const project = useQuery({
    queryKey: ['project', o.project.id],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${o.project.id}`),
  });
  const site = project.data?.sites.find((s) => s.id === draft.siteId);
  const supply = draft.siteId
    ? supplyOf(o.vendor.gstin, site?.stateCode ?? null)
    : o.vendor.gstin
      ? null
      : 'unregistered';
  const taxes = draft.lines.map((l) => draftTax(l.qty, l.rate, l.gstPct, supply));
  const sum = (k: 'amount' | 'cgst' | 'sgst' | 'igst') =>
    taxes.reduce((s, t) => s + (t ? t[k] : 0), 0);
  const [sub, cgst, sgst, igst] = [sum('amount'), sum('cgst'), sum('sgst'), sum('igst')];
  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft({ ...draft, lines: draft.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const blank: LineDraft = {
    resourceId: null,
    resourceCode: null,
    lineKey: null,
    rfqLineId: null,
    description: '',
    hsn: '',
    unit: '',
    qty: '',
    rate: '',
    gstPct: '18',
  };
  const money = (n: number) => rupees(n.toFixed(2));
  return (
    <form
      className="space-y-5"
      aria-label="Order"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Card
        title={r.revision ? `Amendment ${r.revision}` : 'The order'}
        actions={<Badge tone={REVISION_TONE[r.status]}>{REVISION_STATUS[r.status]}</Badge>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Deliver to (site)">
              <Select
                value={draft.siteId}
                onChange={(e) => setDraft({ ...draft, siteId: e.target.value })}
              >
                <option value="">Choose a site</option>
                {project.data?.sites
                  .filter((s) => s.active || s.id === draft.siteId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.stateCode ? ` (${s.stateCode})` : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Deliver by">
              <Input
                type="date"
                value={draft.deliverBy}
                onChange={(e) => setDraft({ ...draft, deliverBy: e.target.value })}
              />
            </Field>
          </div>
          <p className="self-end pb-2 text-sm" data-testid="draft-supply">
            {supply
              ? SUPPLY[supply]
              : draft.siteId
                ? "The site has no GST state code: set it on the project's page."
                : 'The site decides the GST: within its state CGST + SGST, from another IGST.'}
          </p>
          {r.revision > 0 && (
            <div className="sm:col-span-2">
              <Field label="Why amend it">
                <Input
                  value={draft.reason}
                  maxLength={2000}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                />
              </Field>
            </div>
          )}
          <Field label="Payment terms">
            <Textarea
              rows={2}
              value={draft.paymentTerms}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, paymentTerms: e.target.value })}
            />
          </Field>
          <Field label="Delivery terms">
            <Textarea
              rows={2}
              value={draft.deliveryTerms}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, deliveryTerms: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Other terms">
              <Textarea
                rows={2}
                value={draft.otherTerms}
                maxLength={8000}
                onChange={(e) => setDraft({ ...draft, otherTerms: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Card>
      <Card title={`Lines (${draft.lines.length}): rates before GST`}>
        <div className="space-y-3">
          {draft.lines.map((l, i) => {
            const t = taxes[i];
            return (
              <div
                key={i}
                role="group"
                aria-label={`Line ${i + 1}`}
                className="flex flex-wrap items-end gap-2 border-b border-line pb-3"
              >
                <span className="w-6 pb-2 text-sm tabular-nums text-fg-muted">{i + 1}</span>
                <div className="min-w-56 flex-1">
                  <Field label="Description">
                    <Input
                      value={l.description}
                      maxLength={1000}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </Field>
                  {l.resourceCode && (
                    <span className="text-xs text-fg-muted">
                      From the library: {l.resourceCode}
                    </span>
                  )}
                </div>
                <Field label="HSN/SAC">
                  <Input
                    value={l.hsn}
                    inputMode="numeric"
                    maxLength={8}
                    className="w-24"
                    onChange={(e) => setLine(i, { hsn: e.target.value })}
                  />
                </Field>
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
                    className="w-28"
                    onChange={(e) => setLine(i, { rate: e.target.value })}
                  />
                </Field>
                <Field label="GST %">
                  <Select
                    value={l.gstPct}
                    className="w-20"
                    onChange={(e) => setLine(i, { gstPct: e.target.value })}
                  >
                    {['0', '0.25', '3', '5', '12', '18', '28'].map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </Select>
                </Field>
                <span className="w-28 pb-2 text-right text-sm tabular-nums">
                  {t ? money(t.amount) : ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() =>
                    setDraft({ ...draft, lines: draft.lines.filter((_, k) => k !== i) })
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            );
          })}
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
                      rate: res.rate ? trimZeros(res.rate) : '',
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
          <dl
            className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 pt-2 text-sm"
            data-testid="draft-totals"
          >
            <dt className="text-fg-muted">Before GST</dt>
            <dd className="text-right tabular-nums">{money(sub)}</dd>
            {supply === 'intra' && (
              <>
                <dt className="text-fg-muted">CGST</dt>
                <dd className="text-right tabular-nums">{money(cgst)}</dd>
                <dt className="text-fg-muted">SGST</dt>
                <dd className="text-right tabular-nums">{money(sgst)}</dd>
              </>
            )}
            {supply === 'inter' && (
              <>
                <dt className="text-fg-muted">IGST</dt>
                <dd className="text-right tabular-nums">{money(igst)}</dd>
              </>
            )}
            <dt className="font-medium">Total with GST</dt>
            <dd className="text-right font-semibold tabular-nums">
              {money(sub + cgst + sgst + igst)}
            </dd>
          </dl>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            {r.revision > 0 && (
              <Button type="button" variant="ghost" busy={discarding} onClick={onDiscard}>
                Discard the amendment
              </Button>
            )}
            <Button type="submit" busy={saving} disabled={!dirty}>
              Save
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}
