// One approval request (docs/wave2b-plan.md step 1): the document as the approver sees it (they may not be on its
// project), its levels, what happened, and the decision: approve (with a note), reject (with a reason), or a comment;
// its submitter withdraws it.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  Table,
  Textarea,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { ApprovalEvents, ApprovalSteps } from '../approvals/ApprovalTrail';
import { APPROVAL_STATUS, APPROVAL_TONE, useRun, type Approval } from '../approvals/model';
import { formatQty } from '../boq/model';
import { describeError, formatDateTime, formatInr } from '../lib/format';
import type { RequisitionHead, RequisitionLine } from '../procurement/model';
import { RequisitionLines } from '../procurement/RequisitionLines';
import { shortDate } from '../schedule/model';

type Detail = Approval & { document: unknown };

export function ApprovalDetailScreen({ approvalId }: { approvalId: string }) {
  const qc = useQueryClient();
  const key = ['approval', approvalId];
  const a = useQuery({
    queryKey: key,
    queryFn: () => api.request<Detail>(`/api/tenant/approvals/${approvalId}`),
  });
  const { run, busy, error } = useRun(() => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  });
  const [comment, setComment] = useState('');
  if (a.isPending) return <Spinner />;
  if (a.isError) return <Alert tone="danger">{describeError(a.error)}</Alert>;
  const d = a.data;
  const act = (op: 'approve' | 'reject' | 'withdraw' | 'comments') =>
    void run(op, () =>
      api.request(`/api/tenant/approvals/${approvalId}/${op}`, {
        method: 'POST',
        body: comment.trim() ? { comment: comment.trim() } : {},
      }),
    ).then((ok) => ok && setComment(''));
  return (
    <div className="space-y-5">
      <Link
        to="/approvals"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Approvals
      </Link>
      <PageHeader
        title={d.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{d.docLabel}</span>
            <Badge tone={APPROVAL_TONE[d.status]}>{APPROVAL_STATUS[d.status]}</Badge>
            {d.project && (
              <span>
                {d.project.number} · {d.project.name}
              </span>
            )}
          </span>
        }
      />
      <div className="grid gap-5 2xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-5">
          <Card
            title={`${formatInr(d.amount)}, submitted by ${d.submittedBy}`}
            actions={
              d.docType === 'purchase_requisition' ? (
                <Link
                  to="/requisitions/$requisitionId"
                  params={{ requisitionId: d.docId }}
                  className="text-sm text-accent hover:underline"
                >
                  Open the requisition
                </Link>
              ) : d.docType === 'material_budget' ? (
                <Link
                  to="/material-budgets/$budgetId"
                  params={{ budgetId: d.docId }}
                  className="text-sm text-accent hover:underline"
                >
                  Open the budget revision
                </Link>
              ) : null
            }
          >
            <p className="mb-3 text-xs text-fg-muted">{formatDateTime(d.submittedAt)}</p>
            {d.docType === 'purchase_requisition' ? (
              <RequisitionDocument
                doc={d.document as RequisitionHead & { lines: RequisitionLine[] }}
              />
            ) : d.docType === 'material_budget' ? (
              <BudgetDocument doc={d.document as BudgetDoc} />
            ) : null}
          </Card>
          {(d.mayAct || d.mayWithdraw || d.status === 'pending') && (
            <Card title={d.mayAct ? 'Your decision' : 'Comment'}>
              {d.mayAct && d.actingFor && (
                <p className="mb-2 text-sm">
                  You are standing in for <b>{d.actingFor}</b>.
                </p>
              )}
              <Field label={d.mayAct ? 'Note (a reason is needed to reject)' : 'Comment'}>
                <Textarea
                  value={comment}
                  maxLength={2000}
                  rows={2}
                  onChange={(e) => setComment(e.target.value)}
                />
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                {d.mayAct && (
                  <>
                    <Button busy={busy === 'approve'} onClick={() => act('approve')}>
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      busy={busy === 'reject'}
                      disabled={comment.trim().length < 3}
                      onClick={() => act('reject')}
                    >
                      Reject
                    </Button>
                  </>
                )}
                <Button
                  variant="secondary"
                  busy={busy === 'comments'}
                  disabled={comment.trim().length < 3}
                  onClick={() => act('comments')}
                >
                  Add comment
                </Button>
                {d.mayWithdraw && (
                  <Button
                    variant="ghost"
                    busy={busy === 'withdraw'}
                    onClick={() => act('withdraw')}
                  >
                    Withdraw
                  </Button>
                )}
              </div>
              {error && (
                <div className="mt-3">
                  <Alert tone="danger">{error}</Alert>
                </div>
              )}
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <Card title="Levels">
            {d.steps.length ? (
              <ApprovalSteps approval={d} />
            ) : (
              <p className="text-sm text-fg-muted">No approval needed for this amount.</p>
            )}
          </Card>
          <Card title="History">
            <ApprovalEvents approval={d} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function RequisitionDocument({ doc }: { doc: RequisitionHead & { lines: RequisitionLine[] } }) {
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-fg-muted">Requisition</dt>
        <dd>
          {doc.number} · {doc.title}
        </dd>
        {doc.site && (
          <>
            <dt className="text-fg-muted">Site</dt>
            <dd>{doc.site.name}</dd>
          </>
        )}
        {doc.neededBy && (
          <>
            <dt className="text-fg-muted">Needed by</dt>
            <dd>{shortDate(doc.neededBy)}</dd>
          </>
        )}
        {doc.createdBy && (
          <>
            <dt className="text-fg-muted">Raised by</dt>
            <dd>{doc.createdBy}</dd>
          </>
        )}
        {doc.notes && (
          <>
            <dt className="text-fg-muted">Notes</dt>
            <dd className="whitespace-pre-wrap">{doc.notes}</dd>
          </>
        )}
      </dl>
      <RequisitionLines lines={doc.lines} total={doc.amount} />
    </div>
  );
}

interface BudgetDoc {
  revision: number;
  reason: string;
  total: string;
  basedOn: { revision: number } | null;
  lines: {
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    qty: string;
    rate: string | null;
    amount: string | null;
    prevQty: string | null;
    prevAmount: string | null;
  }[];
}

/** A budget revision as its approver sees it: each resource against the revision before. */
function BudgetDocument({ doc }: { doc: BudgetDoc }) {
  const changed = doc.lines.filter(
    (l) => !doc.basedOn || l.qty !== (l.prevQty ?? '0') || l.amount !== l.prevAmount,
  );
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Revision {doc.revision}
        {doc.basedOn && ` of revision ${doc.basedOn.revision}`}: {formatInr(doc.total)}.
        {doc.reason && <span className="block text-fg-muted">Why: {doc.reason}</span>}
      </p>
      <Table minWidth="40rem">
        <thead>
          <tr>
            <th>Resource</th>
            <th className="text-right">Quantity</th>
            {doc.basedOn && <th className="text-right">Was</th>}
            <th className="text-right">Amount</th>
            {doc.basedOn && <th className="text-right">Was</th>}
          </tr>
        </thead>
        <tbody aria-label={doc.basedOn ? 'Changes' : 'Budget'}>
          {changed.map((l) => (
            <tr key={l.resourceId}>
              <td>
                <span className="mr-2 font-mono text-xs">{l.code}</span>
                {l.name}
              </td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {formatQty(l.qty)} {l.unit}
              </td>
              {doc.basedOn && (
                <td className="whitespace-nowrap text-right tabular-nums text-fg-muted">
                  {l.prevQty === null ? 'new' : `${formatQty(l.prevQty)} ${l.unit}`}
                </td>
              )}
              <td className="text-right tabular-nums">{formatInr(l.amount)}</td>
              {doc.basedOn && (
                <td className="text-right tabular-nums text-fg-muted">{formatInr(l.prevAmount)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      {doc.basedOn && changed.length < doc.lines.length && (
        <p className="text-xs text-fg-muted">
          {doc.lines.length - changed.length} resource
          {doc.lines.length - changed.length === 1 ? '' : 's'} unchanged.
        </p>
      )}
    </div>
  );
}
