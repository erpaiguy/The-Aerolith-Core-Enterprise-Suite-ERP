// Tender management detail on the tender page (docs/wave1-plan.md step 8): pre-bid queries, addenda, EMD and bank
// guarantees, the submission checklist, the submission itself, the bids read out at the opening and the result.
import { SorTendering } from './SorTendering';
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
  Textarea,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client';
import type {
  ChecklistItem,
  OpenedBid,
  Party,
  Person,
  ResultCategory,
  SecurityForm,
  SecurityInstrument,
  SecurityStatus,
  TenderDetail,
  TenderQuery,
  TenderWork,
} from '../api/types';
import {
  describeError,
  formatDate,
  formatDateTime,
  formatInr,
  fromLocalInput,
  toLocalInput,
} from '../lib/format';
import { LinkedDocuments } from '../documents/LinkedDocuments';
import { usePermission } from '../session/permissions';
import { useSession } from '../session/session';
import { TenderDocuments } from './Documents';
import { TenderProgrammes } from './Programme';
import { TenderRfqs } from './Rfq';

export const useTenderWork = (tenderId: string) =>
  useQuery({
    queryKey: ['tender-work', tenderId],
    queryFn: () => api.request<TenderWork>(`/api/tenant/tenders/${tenderId}/work`),
  });

/** Runs a change, shows its error, and refreshes the tender afterwards. */
function useAction(onDone: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `done` is the toast once it has worked; none for a status picked in a list. */
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (done) toast.success(done);
      onDone();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, error };
}

const post = (url: string, body: object = {}) =>
  api.request(`/api/tenant/${url}`, { method: 'POST', body });

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const money = (v: string) => v.replace(/,/g, '').trim() || null;

// --- queries and addenda ---

const QUERY_TONE = {
  draft: 'neutral',
  sent: 'warning',
  answered: 'success',
  withdrawn: 'neutral',
} as const;

function QueryRow({
  q,
  canEdit,
  run,
  busy,
}: {
  q: TenderQuery;
  canEdit: boolean;
  run: ReturnType<typeof useAction>['run'];
  busy: string | null;
}) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const confirm = useConfirm();
  const update = (body: object) => post(`queries/${q.id}`, { rowVersion: q.rowVersion, ...body });
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="mr-2 font-mono text-xs text-fg-muted">Q{q.seq}</span>
          {q.reference && <span className="mr-2 text-xs text-fg-muted">{q.reference}</span>}
          <Badge tone={QUERY_TONE[q.status]}>{q.status}</Badge>
          <p
            className={cx(
              'mt-1 whitespace-pre-wrap',
              q.status === 'withdrawn' && 'line-through text-fg-subtle',
            )}
          >
            {q.question}
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-1">
            {q.status === 'draft' && (
              <>
                <Button
                  variant="secondary"
                  busy={busy === `send-${q.id}`}
                  onClick={() =>
                    void run(
                      `send-${q.id}`,
                      () => update({ status: 'sent' }),
                      `Q${q.seq} marked sent`,
                    )
                  }
                >
                  Mark sent
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete query ${q.seq}`}
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: `Delete query Q${q.seq}?`,
                        body: 'The draft question is deleted; it has not been sent to the client.',
                        confirmLabel: 'Delete the query',
                        tone: 'danger',
                      }))
                    )
                      return;
                    await run(
                      `del-${q.id}`,
                      () => post(`queries/${q.id}/delete`),
                      `Q${q.seq} deleted`,
                    );
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            )}
            {q.status === 'sent' && !answering && (
              <>
                <Button variant="secondary" onClick={() => setAnswering(true)}>
                  Record answer
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run(
                      `wd-${q.id}`,
                      () => update({ status: 'withdrawn' }),
                      `Q${q.seq} withdrawn`,
                    )
                  }
                >
                  Withdraw
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {q.answer && (
        <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-sm">
          <span className="font-medium">
            Answer{q.answeredOn ? ` (${formatDate(q.answeredOn)})` : ''}:{' '}
          </span>
          {q.answer}
        </p>
      )}
      {q.sentOn && !q.answer && (
        <p className="text-xs text-fg-muted">
          Sent {formatDate(q.sentOn)}, awaiting the client&apos;s answer.
        </p>
      )}
      {answering && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              `ans-${q.id}`,
              () => update({ status: 'answered', answer }),
              `Answer to Q${q.seq} recorded`,
            ).then((ok) => ok && setAnswering(false));
          }}
        >
          <Field label={`Client's answer to Q${q.seq}`}>
            <Textarea
              rows={2}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" busy={busy === `ans-${q.id}`} disabled={!answer.trim()}>
              Save answer
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAnswering(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function QueriesAndAddenda({
  tender,
  work,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  work: TenderWork;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { run, busy, error } = useAction(onChanged);
  const canAttach = usePermission('documents.edit');
  const [reference, setReference] = useState('');
  const [question, setQuestion] = useState('');
  const [adding, setAdding] = useState(false);
  const [a, setA] = useState({
    ref: '',
    issuedOn: today(),
    summary: '',
    newDue: '',
    affectsBoq: false,
  });

  const addQuery = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'query',
      () => post(`tenders/${tender.id}/queries`, { reference, question }),
      'Query added',
    ).then((ok) => {
      if (ok) {
        setReference('');
        setQuestion('');
      }
    });
  };
  const addAddendum = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'addendum',
      () =>
        post(`tenders/${tender.id}/addenda`, {
          ref: a.ref,
          issuedOn: a.issuedOn,
          summary: a.summary,
          affectsBoq: a.affectsBoq,
          newSubmissionDueAt: fromLocalInput(a.newDue),
        }),
      `Addendum ${a.ref.trim()} recorded`,
    ).then((ok) => {
      if (ok) {
        setAdding(false);
        setA({ ref: '', issuedOn: today(), summary: '', newDue: '', affectsBoq: false });
      }
    });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Pre-bid queries">
        {tender.queriesDueAt && (
          <p className="mb-3 text-sm text-fg-muted">
            Last day for queries: {formatDateTime(tender.queriesDueAt)}
          </p>
        )}
        {work.queries.length === 0 ? (
          <EmptyState title="No queries raised.">
            Questions for the client before the pre-bid meeting go here.
          </EmptyState>
        ) : (
          <ol className="divide-y divide-line text-sm" aria-label="Queries">
            {work.queries.map((q) => (
              <QueryRow key={q.id} q={q} canEdit={canEdit} run={run} busy={busy} />
            ))}
          </ol>
        )}
        {canEdit && (
          <form onSubmit={addQuery} className="mt-4 space-y-2 border-t border-line pt-4">
            <Field label="Reference" hint="Clause, page or BOQ item the query is about.">
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Question">
              <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              busy={busy === 'query'}
              disabled={question.trim().length < 3}
            >
              <Plus className="size-4" aria-hidden /> Add query
            </Button>
          </form>
        )}
      </Card>

      <Card
        title="Addenda and corrigenda"
        actions={
          canEdit &&
          !adding && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Addendum
            </Button>
          )
        }
      >
        {adding && (
          <form
            onSubmit={addAddendum}
            className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Number" hint="As the client numbers it, e.g. Corrigendum 2.">
                <Input
                  value={a.ref}
                  onChange={(e) => setA({ ...a, ref: e.target.value })}
                  required
                />
              </Field>
              <Field label="Issued on">
                <Input
                  type="date"
                  value={a.issuedOn}
                  onChange={(e) => setA({ ...a, issuedOn: e.target.value })}
                  required
                />
              </Field>
            </div>
            <Field label="What it changes">
              <Textarea
                rows={3}
                value={a.summary}
                onChange={(e) => setA({ ...a, summary: e.target.value })}
              />
            </Field>
            <Field
              label="New submission date"
              hint="Only if this addendum extends (or advances) the due date. Reminders follow it."
            >
              <Input
                type="datetime-local"
                value={a.newDue}
                onChange={(e) => setA({ ...a, newDue: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={a.affectsBoq}
                onChange={(e) => setA({ ...a, affectsBoq: e.target.checked })}
              />
              Changes the BOQ
            </label>
            <div className="flex gap-2">
              <Button
                type="submit"
                busy={busy === 'addendum'}
                disabled={!a.ref.trim() || a.summary.trim().length < 3}
              >
                Add addendum
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {work.addenda.length === 0 ? (
          <EmptyState title="No addenda issued.">
            Record each corrigendum the client issues; a new due date moves the deadline.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Addenda">
            {work.addenda.map((x) => (
              <li key={x.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{x.ref}</span>
                  <span className="text-xs text-fg-muted">{formatDate(x.issuedOn)}</span>
                  {x.affectsBoq && <Badge tone="warning">changes the BOQ</Badge>}
                  <label className="ml-auto flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={x.acknowledged}
                      disabled={!canEdit}
                      onChange={(e) =>
                        void run(`ack-${x.id}`, () =>
                          post(`addenda/${x.id}`, {
                            rowVersion: x.rowVersion,
                            acknowledged: e.target.checked,
                          }),
                        )
                      }
                    />
                    Acknowledged in the bid
                  </label>
                </div>
                <p className="whitespace-pre-wrap">{x.summary}</p>
                <LinkedDocuments
                  vault={`tenders/${tender.id}`}
                  kind="addendum"
                  targetId={x.id}
                  label={x.ref}
                  documents={x.documents}
                  folder="03 Addenda and corrigenda"
                  canAttach={canAttach}
                  onChanged={onChanged}
                />
                {x.affectsBoq && (
                  <p className="text-xs text-fg-muted">
                    To bring the client&apos;s revised BOQ in: open the BOQ, start a revision if it
                    is frozen, and use Import revised BOQ. Compare then shows what this addendum
                    changed.
                  </p>
                )}
                {x.dueAfter && (
                  <p className="text-xs text-fg-muted">
                    Submission moved{x.dueBefore ? ` from ${formatDateTime(x.dueBefore)}` : ''} to{' '}
                    {formatDateTime(x.dueAfter)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {error && (
        <div className="xl:col-span-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </div>
  );
}

// --- EMD and bank guarantees ---

export const FORM_LABEL: Record<SecurityForm, string> = {
  bank_guarantee: 'Bank guarantee',
  demand_draft: 'Demand draft',
  fdr: 'FDR',
  online: 'Online payment',
  insurance_bond: 'Insurance surety bond',
  exempt: 'Exempt (MSE / Udyam)',
};
const SECURITY_STATUS: Record<SecurityStatus, string> = {
  planned: 'To arrange',
  issued: 'With us',
  submitted: 'With the client',
  returned: 'Returned',
  adjusted: 'Adjusted',
  forfeited: 'Forfeited',
  cancelled: 'Cancelled',
};
const PURPOSE: Record<SecurityInstrument['purpose'], string> = {
  emd: 'EMD',
  performance: 'Performance',
  other: 'Other',
};

export function Securities({
  tender,
  work,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  work: TenderWork;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { run, busy, error } = useAction(onChanged);
  const blank = () => ({
    purpose: 'emd',
    form: 'bank_guarantee' as SecurityForm,
    amount: tender.emdAmount ?? '',
    bank: '',
    instrumentNo: '',
    issuedOn: '',
    validUntil: '',
    status: 'planned' as SecurityStatus,
  });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState(blank);
  const set = (k: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'add',
      () =>
        post(`tenders/${tender.id}/securities`, {
          ...v,
          amount: money(v.amount) ?? '0',
          bank: v.bank,
          instrumentNo: v.instrumentNo,
          issuedOn: v.issuedOn || null,
          validUntil: v.validUntil || null,
        }),
      'Security recorded',
    ).then((ok) => {
      if (ok) {
        setAdding(false);
        setV(blank());
      }
    });
  };
  const now = today();

  return (
    <Card
      title="EMD and bank guarantees"
      actions={
        canEdit &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> Add
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        EMD asked for: {formatInr(tender.emdAmount)}
        {work.bidValidityEnd && (
          <>
            {' '}
            · the bid stays valid until {formatDate(work.bidValidityEnd)}; a guarantee for the EMD
            must run longer (clients usually ask for 45 days more).
          </>
        )}{' '}
        Expiry reminders go to the tender&apos;s owner 30 and 7 days ahead.
      </p>
      {adding && (
        <form
          onSubmit={add}
          className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="For">
              <Select value={v.purpose} onChange={set('purpose')}>
                {Object.entries(PURPOSE).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Form">
              <Select value={v.form} onChange={set('form')}>
                {Object.entries(FORM_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount (₹)">
              <Input inputMode="decimal" value={v.amount} onChange={set('amount')} />
            </Field>
            <Field label="Bank">
              <Input value={v.bank} onChange={set('bank')} />
            </Field>
            <Field label="Number">
              <Input value={v.instrumentNo} onChange={set('instrumentNo')} />
            </Field>
            <Field label="Status">
              <Select value={v.status} onChange={set('status')}>
                {Object.entries(SECURITY_STATUS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Issued on">
              <Input type="date" value={v.issuedOn} onChange={set('issuedOn')} />
            </Field>
            <Field label="Valid until">
              <Input type="date" value={v.validUntil} onChange={set('validUntil')} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" busy={busy === 'add'}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {work.securities.length === 0 ? (
        <EmptyState title="Nothing recorded yet.">
          Record the EMD and any other security given with the bid.
        </EmptyState>
      ) : (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Instrument</th>
              <th className="text-right">Amount</th>
              <th>Valid until</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {work.securities.map((s) => {
              const live = s.status === 'issued' || s.status === 'submitted';
              const expired = live && s.validUntil !== null && s.validUntil < now;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="font-medium">
                      {PURPOSE[s.purpose]} · {FORM_LABEL[s.form]}
                    </div>
                    <div className="text-xs text-fg-muted">
                      {[s.bank, s.instrumentNo].filter(Boolean).join(' · ') || '-'}
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{formatInr(s.amount)}</td>
                  <td>
                    {s.validUntil ? formatDate(s.validUntil) : '-'}{' '}
                    {expired && <Badge tone="danger">expired</Badge>}
                    {s.shortOfValidity && !expired && (
                      <Badge tone="warning">shorter than the bid validity</Badge>
                    )}
                  </td>
                  <td>
                    {canEdit ? (
                      <Select
                        aria-label={`Status of ${FORM_LABEL[s.form]} ${s.instrumentNo ?? ''}`.trim()}
                        value={s.status}
                        onChange={(e) =>
                          void run(`st-${s.id}`, () =>
                            post(`securities/${s.id}`, {
                              rowVersion: s.rowVersion,
                              status: e.target.value,
                            }),
                          )
                        }
                      >
                        {Object.entries(SECURITY_STATUS).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      SECURITY_STATUS[s.status]
                    )}
                    {s.returnedOn && (
                      <div className="text-xs text-fg-muted">
                        returned {formatDate(s.returnedOn)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

// --- checklist ---

const ENVELOPE: Record<ChecklistItem['envelope'], string> = {
  technical: 'Technical / pre-qualification',
  financial: 'Financial',
  other: 'Other',
};
const CHECK_STATUS: Record<ChecklistItem['status'], string> = {
  pending: 'Pending',
  ready: 'Ready',
  not_applicable: 'Not applicable',
};

export function Checklist({
  tender,
  work,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  work: TenderWork;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { user } = useSession();
  const { run, busy, error } = useAction(onChanged);
  const confirm = useConfirm();
  const canAttach = usePermission('documents.edit');
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
    enabled: canEdit,
  });
  const blank = { title: '', envelope: 'technical', required: true, assigneeId: '', dueOn: '' };
  const [v, setV] = useState(blank);
  const items = work.checklist;
  const required = items.filter((c) => c.required);
  const done = required.filter((c) => c.status !== 'pending').length;
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'add',
      () =>
        post(`tenders/${tender.id}/checklist`, {
          ...v,
          assigneeId: v.assigneeId || null,
          dueOn: v.dueOn || null,
        }),
      'Checklist item added',
    ).then((ok) => ok && setV(blank));
  };

  return (
    <Card
      title="Submission checklist"
      actions={
        canEdit && (
          <Button
            variant="secondary"
            busy={busy === 'standard'}
            onClick={() =>
              void run(
                'standard',
                () => post(`tenders/${tender.id}/checklist/standard`),
                'Standard documents added',
              )
            }
          >
            Add the standard documents
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <EmptyState title="Nothing on the list yet.">
          The standard documents cover what most Indian works tenders ask for (EMD, PAN, GST,
          experience and turnover certificates, affidavits, the priced BOQ); edit them to match this
          tender.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-sm" data-testid="checklist-progress">
            {done} of {required.length} required documents ready
          </p>
          {(['technical', 'financial', 'other'] as const).map((env) => {
            const rows = items.filter((c) => c.envelope === env);
            if (rows.length === 0) return null;
            return (
              <div key={env} className="mb-4">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
                  {ENVELOPE[env]}
                </h3>
                <ul
                  className="divide-y divide-line text-sm"
                  aria-label={`${ENVELOPE[env]} documents`}
                >
                  {rows.map((c) => {
                    const mayTick = canEdit || (user !== null && c.assigneeId === user.id);
                    return (
                      <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
                        <Select
                          aria-label={`Status of ${c.title}`}
                          className="w-36"
                          value={c.status}
                          disabled={!mayTick}
                          onChange={(e) =>
                            void run(`st-${c.id}`, () =>
                              post(`checklist/${c.id}`, {
                                rowVersion: c.rowVersion,
                                status: e.target.value,
                              }),
                            )
                          }
                        >
                          {Object.entries(CHECK_STATUS).map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </Select>
                        <span
                          className={cx(
                            'min-w-0 flex-1',
                            c.status === 'not_applicable' && 'text-fg-subtle line-through',
                          )}
                        >
                          {c.title}
                          {c.required && <span className="text-danger"> *</span>}
                        </span>
                        <span className="text-xs text-fg-muted">
                          {[c.assignee, c.dueOn && `due ${formatDate(c.dueOn)}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <LinkedDocuments
                          vault={`tenders/${tender.id}`}
                          kind="checklist_item"
                          targetId={c.id}
                          label={c.title}
                          documents={c.documents}
                          folder={
                            c.envelope === 'financial'
                              ? '06 Our financial bid'
                              : c.envelope === 'technical'
                                ? '05 Our technical bid'
                                : null
                          }
                          canAttach={canAttach}
                          onChanged={onChanged}
                        />
                        {canEdit && (
                          <Button
                            variant="ghost"
                            aria-label={`Remove ${c.title}`}
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `Remove ${c.title} from the checklist?`,
                                  body: 'The item and its status are deleted from this tender’s checklist.',
                                  confirmLabel: 'Remove the item',
                                  tone: 'danger',
                                }))
                              )
                                return;
                              await run(
                                `del-${c.id}`,
                                () => post(`checklist/${c.id}/delete`),
                                `${c.title} removed`,
                              );
                            }}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </>
      )}
      {canEdit && (
        <form
          onSubmit={add}
          className="mt-2 grid gap-2 border-t border-line pt-4 md:grid-cols-[1fr_10rem_10rem_9rem_auto]"
        >
          <Field label="Document">
            <Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
          </Field>
          <Field label="Envelope">
            <Select value={v.envelope} onChange={(e) => setV({ ...v, envelope: e.target.value })}>
              {Object.entries(ENVELOPE).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who">
            <Select
              value={v.assigneeId}
              onChange={(e) => setV({ ...v, assigneeId: e.target.value })}
            >
              <option value="">Nobody</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due on">
            <Input
              type="date"
              value={v.dueOn}
              onChange={(e) => setV({ ...v, dueOn: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button
              type="submit"
              variant="secondary"
              busy={busy === 'add'}
              disabled={v.title.trim().length < 2}
            >
              <Plus className="size-4" aria-hidden /> Add
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

// --- submission ---

/** What still stands in the way of submitting, from the checklist, addenda and EMD. */
export function Readiness({ work }: { work: TenderWork }) {
  const r = work.readiness;
  const problems: ReactNode[] = [];
  if (r.checklistPending.length)
    problems.push(
      <>
        {r.checklistPending.length} required document{r.checklistPending.length === 1 ? '' : 's'}{' '}
        not ready: {r.checklistPending.slice(0, 4).join(', ')}
        {r.checklistPending.length > 4 ? ' and more' : ''}
      </>,
    );
  if (r.addendaUnacknowledged)
    problems.push(
      `${r.addendaUnacknowledged} addend${r.addendaUnacknowledged === 1 ? 'um' : 'a'} not acknowledged`,
    );
  if (r.emdRequired && !r.emdCovered) problems.push('No EMD arranged (or exemption recorded)');
  if (r.queriesUnanswered)
    problems.push(
      `${r.queriesUnanswered} quer${r.queriesUnanswered === 1 ? 'y' : 'ies'} still unanswered`,
    );
  if (problems.length === 0)
    return r.checklistRequired ? (
      <Alert tone="success">Every required document is ready.</Alert>
    ) : null;
  return (
    <Alert tone="warning">
      <ul className="list-disc space-y-0.5 pl-4">
        {problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Records handing in the bid (the first one moves the tender to submitted and freezes its BOQs). */
export function SubmissionForm({
  tender,
  revised,
  onDone,
  onCancel,
}: {
  tender: TenderDetail;
  revised: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const canPrice = usePermission('pricing.edit');
  const work = useTenderWork(tender.id);
  const summary = useQuery({
    queryKey: ['bid-summary', tender.id],
    queryFn: () =>
      api.request<{ bid: string; beforeGst: string }>(
        `/api/tenant/tenders/${tender.id}/bid-summary`,
      ),
    enabled: canPrice,
  });
  const [v, setV] = useState({
    at: toLocalInput(new Date().toISOString()),
    mode: 'portal',
    reference: '',
    bidValue: '',
    notes: '',
  });
  const { run, busy, error } = useAction(onDone);
  const suggested = summary.data && Number(summary.data.bid) > 0 ? summary.data.bid : null;
  return (
    <form
      className="space-y-3 rounded-md border border-line bg-surface-2 p-3"
      aria-label={revised ? 'Record a revised offer' : 'Record the submission'}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          'submit',
          () =>
            post(`tenders/${tender.id}/submissions`, {
              submittedAt: fromLocalInput(v.at),
              mode: v.mode,
              reference: v.reference,
              bidValue: money(v.bidValue),
              notes: v.notes,
            }),
          revised ? 'Revised offer recorded' : 'Submission recorded',
        );
      }}
    >
      {!revised && work.data && <Readiness work={work.data} />}
      {!revised && (
        <p className="text-sm text-fg-muted">
          Recording the submission freezes the tender&apos;s draft BOQs as submitted; changes after
          it need a new revision.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Submitted at">
          <Input
            type="datetime-local"
            value={v.at}
            onChange={(e) => setV({ ...v, at: e.target.value })}
            required
          />
        </Field>
        <Field label="How">
          <Select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
            <option value="portal">e-tender portal</option>
            <option value="physical">By hand / post</option>
            <option value="email">Email</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Acknowledgement or receipt number">
          <Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
        </Field>
        {canPrice && (
          <Field
            label="Bid value (₹)"
            hint={
              suggested ? `The chosen pricing gives ${formatInr(suggested)} with GST.` : undefined
            }
          >
            <Input
              inputMode="decimal"
              value={v.bidValue}
              placeholder={suggested ?? ''}
              onChange={(e) => setV({ ...v, bidValue: e.target.value })}
            />
          </Field>
        )}
      </div>
      <Field label="Notes">
        <Textarea
          rows={2}
          value={v.notes}
          onChange={(e) => setV({ ...v, notes: e.target.value })}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy === 'submit'}>
          {revised ? 'Record revised offer' : 'Record submission'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}

const CATEGORY: Record<ResultCategory, string> = {
  price: 'Price',
  technical: 'Technical evaluation',
  qualification: 'Qualification / eligibility',
  documents: 'Documents or EMD',
  scope: 'Scope or terms',
  client: 'Client decision (scrapped, re-tendered)',
  other: 'Other',
};

/** Won or lost, with the main reason, the value, and (lost) who won. */
export function ResultForm({
  tender,
  outcome,
  onDone,
  onCancel,
}: {
  tender: TenderDetail;
  outcome: 'won' | 'lost';
  onDone: () => void;
  onCancel: () => void;
}) {
  const work = useTenderWork(tender.id);
  const competitors = useQuery({
    queryKey: ['parties', 'competitor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=competitor'),
  });
  const l1 = work.data?.bids.find((b) => b.rank === 1 && !b.us);
  const [v, setV] = useState({
    on: today(),
    category: outcome === 'lost' ? 'price' : '',
    reason: '',
    value: '',
    winner: '',
  });
  const { run, busy, error } = useAction(onDone);
  const lost = outcome === 'lost';
  return (
    <form
      className="space-y-3 rounded-md border border-line bg-surface-2 p-3"
      aria-label={lost ? 'Record the loss' : 'Record the win'}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          'result',
          () =>
            post(`tenders/${tender.id}/result`, {
              outcome,
              on: v.on || null,
              category: v.category || null,
              reason: v.reason,
              // Lost to L1 with no figure typed: the winning bid is L1's value at the opening.
              value:
                money(v.value) ?? (lost && !v.winner.trim() ? (l1?.quotedValue ?? null) : null),
              winnerName: lost ? v.winner.trim() || l1?.name || null : null,
            }),
          lost ? 'Loss recorded' : 'Win recorded',
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={lost ? 'Result known on' : 'Letter of acceptance on'}>
          <Input type="date" value={v.on} onChange={(e) => setV({ ...v, on: e.target.value })} />
        </Field>
        <Field label="Main reason">
          <Select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
            <option value="">Not recorded</option>
            {Object.entries(CATEGORY).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={lost ? 'Winning bid (₹)' : 'Contract value (₹)'}
          hint={
            lost && l1?.quotedValue ? `L1 at the opening: ${formatInr(l1.quotedValue)}` : undefined
          }
        >
          <Input
            inputMode="decimal"
            value={v.value}
            onChange={(e) => setV({ ...v, value: e.target.value })}
          />
        </Field>
        {lost && (
          <Field label="Won by" hint={l1?.name ? `L1 at the opening: ${l1.name}` : undefined}>
            <Input
              list="competitor-names"
              value={v.winner}
              placeholder={l1?.name ?? ''}
              onChange={(e) => setV({ ...v, winner: e.target.value })}
            />
          </Field>
        )}
      </div>
      <datalist id="competitor-names">
        {(competitors.data ?? []).map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <Field
        label={lost ? 'Reason (lost)' : 'Notes'}
        hint={lost ? 'For example: L2 by 1.8%.' : undefined}
      >
        <Textarea
          rows={2}
          value={v.reason}
          onChange={(e) => setV({ ...v, reason: e.target.value })}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant={lost ? 'secondary' : 'primary'}
          busy={busy === 'result'}
          disabled={lost && v.reason.trim().length < 3}
        >
          {lost ? 'Mark lost' : 'Mark won'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}

// --- opening ---

interface BidDraft {
  key: number;
  us: boolean;
  name: string;
  value: string;
  /** % above (or, negative, below) the estimate, on a percentage-rate tender. */
  pct: string;
  qualified: boolean;
}
let nextKey = 1;

function OpeningEditor({
  tender,
  bids,
  ourValue,
  onDone,
  onCancel,
}: {
  tender: TenderDetail;
  bids: OpenedBid[];
  ourValue: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const competitors = useQuery({
    queryKey: ['parties', 'competitor'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=competitor'),
  });
  const [rows, setRows] = useState<BidDraft[]>(() => {
    const ours = bids.find((b) => b.us);
    return [
      {
        key: nextKey++,
        us: true,
        name: '',
        value: ours?.quotedValue ?? ourValue ?? '',
        pct: ours?.quotedPct ?? '',
        qualified: ours?.qualified ?? true,
      },
      ...bids
        .filter((b) => !b.us)
        .map((b) => ({
          key: nextKey++,
          us: false,
          name: b.name ?? '',
          value: b.quotedValue ?? '',
          pct: b.quotedPct ?? '',
          qualified: b.qualified,
        })),
      { key: nextKey++, us: false, name: '', value: '', pct: '', qualified: true },
    ];
  });
  const { run, busy, error } = useAction(onDone);
  const set = (key: number, patch: Partial<BidDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.us || r.name.trim());
  return (
    <form
      aria-label="Bids at the opening"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          'save',
          () =>
            post(`tenders/${tender.id}/bids`, {
              bids: filled.map((r) => ({
                us: r.us,
                name: r.us ? null : r.name.trim(),
                // A percentage alone: the server works out the value from the estimate.
                quotedValue: r.pct.trim() && !r.value.trim() ? null : money(r.value),
                quotedPct: r.pct.trim() || null,
                qualified: r.qualified,
              })),
            }),
          'Bids at the opening saved',
        );
      }}
      className="space-y-3"
    >
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th>Bidder</th>
            <th className="text-right">Quoted (₹)</th>
            <th className="text-right">or % on estimate</th>
            <th>Qualified</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td>
                {r.us ? (
                  <span className="font-medium">Us</span>
                ) : (
                  <Input
                    aria-label={`Bidder ${i}`}
                    list="opening-competitors"
                    value={r.name}
                    onChange={(e) => set(r.key, { name: e.target.value })}
                  />
                )}
              </td>
              <td>
                <Input
                  aria-label={r.us ? 'Our quoted value' : `Bidder ${i} quoted value`}
                  className="text-right"
                  inputMode="decimal"
                  value={r.value}
                  onChange={(e) => set(r.key, { value: e.target.value })}
                />
              </td>
              <td>
                <Input
                  aria-label={r.us ? 'Our percentage' : `Bidder ${i} percentage`}
                  className="w-24 text-right"
                  inputMode="decimal"
                  placeholder="-4.5"
                  value={r.pct}
                  onChange={(e) =>
                    set(r.key, { pct: e.target.value, value: e.target.value ? '' : r.value })
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={r.us ? 'We qualified' : `Bidder ${i} qualified`}
                  checked={r.qualified}
                  onChange={(e) => set(r.key, { qualified: e.target.checked })}
                />
              </td>
              <td className="text-right">
                {!r.us && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove bidder ${i}`}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <datalist id="opening-competitors">
        {(competitors.data ?? []).map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              { key: nextKey++, us: false, name: '', value: '', pct: '', qualified: true },
            ])
          }
        >
          <Plus className="size-4" aria-hidden /> Bidder
        </Button>
        <span className="flex-1" />
        <Button type="submit" busy={busy === 'save'}>
          Save bids
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function SubmissionAndResult({
  tender,
  work,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  work: TenderWork;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [revising, setRevising] = useState(false);
  const [editingBids, setEditingBids] = useState(false);
  const opened = ['submitted', 'won', 'lost'].includes(tender.status);
  const lastValue = [...work.submissions].reverse().find((s) => s.bidValue)?.bidValue ?? null;
  const o = work.opening;
  return (
    <div className="space-y-5">
      <SorTendering tenderId={tender.id} canEdit={canEdit} />
      {tender.status === 'bidding' && (
        <Card title="Ready to submit?">
          <Readiness work={work} />
          <p className="mt-3 text-sm text-fg-muted">
            Use &quot;Mark submitted&quot; above to record the submission.
          </p>
        </Card>
      )}
      <Card
        title="Submissions"
        actions={
          canEdit &&
          tender.status === 'submitted' &&
          !revising && (
            <Button variant="secondary" onClick={() => setRevising(true)}>
              Revised offer
            </Button>
          )
        }
      >
        {revising && (
          <div className="mb-4">
            <SubmissionForm
              tender={tender}
              revised
              onDone={() => {
                setRevising(false);
                onChanged();
              }}
              onCancel={() => setRevising(false)}
            />
          </div>
        )}
        {work.submissions.length === 0 ? (
          <EmptyState title="Not submitted yet." />
        ) : (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>When</th>
                <th>How</th>
                <th>Reference</th>
                <th className="text-right">Bid value</th>
              </tr>
            </thead>
            <tbody>
              {work.submissions.map((s) => (
                <tr key={s.id}>
                  <td>
                    {formatDateTime(s.submittedAt)}
                    {s.kind === 'revised' && (
                      <>
                        {' '}
                        <Badge tone="warning">revised</Badge>
                      </>
                    )}
                    {s.by && <div className="text-xs text-fg-muted">{s.by}</div>}
                  </td>
                  <td>{s.mode}</td>
                  <td className="text-fg-muted">{s.reference ?? '-'}</td>
                  <td className="text-right tabular-nums">
                    {s.bidValue ? formatInr(s.bidValue) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {opened && (
        <Card
          title="Bids at the opening"
          actions={
            canEdit &&
            !editingBids && (
              <Button variant="secondary" onClick={() => setEditingBids(true)}>
                {work.bids.length ? 'Edit bids' : 'Record bids'}
              </Button>
            )
          }
        >
          {editingBids ? (
            <OpeningEditor
              tender={tender}
              bids={work.bids}
              ourValue={lastValue}
              onDone={() => {
                setEditingBids(false);
                onChanged();
              }}
              onCancel={() => setEditingBids(false)}
            />
          ) : work.bids.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Record the bids read out at the opening (or published on the portal) to see where we
              stood.
            </p>
          ) : (
            <>
              {o && (
                <p className="mb-3 text-sm" data-testid="our-position">
                  {o.ourRank === 1
                    ? `We were L1 of ${o.bidders} bidders.`
                    : o.ourRank
                      ? `We were L${o.ourRank} of ${o.bidders} bidders${o.aboveL1Pct !== null ? `, ${o.aboveL1Pct} % above L1` : ''}.`
                      : `${o.bidders} bidders.`}
                </p>
              )}
              <Table minWidth="32rem">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Bidder</th>
                    <th className="text-right">Quoted</th>
                    {work.bids.some((b) => b.quotedPct !== null) && (
                      <th className="text-right">% on estimate</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {work.bids.map((b) => (
                    <tr key={b.id} className={cx(b.us && 'font-medium')}>
                      <td>{b.rank ? `L${b.rank}` : b.qualified ? '-' : 'Disqualified'}</td>
                      <td>{b.us ? 'Us' : b.name}</td>
                      <td className="text-right tabular-nums">{formatInr(b.quotedValue)}</td>
                      {work.bids.some((x) => x.quotedPct !== null) && (
                        <td className="text-right tabular-nums">
                          {b.quotedPct === null
                            ? ''
                            : `${Number(b.quotedPct) > 0 ? '+' : ''}${Number(b.quotedPct)}%`}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Card>
      )}

      {(tender.status === 'won' || tender.status === 'lost') && (
        <Card title="Result">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-fg-muted">Outcome</dt>
            <dd>
              <Badge tone={tender.status === 'won' ? 'success' : 'danger'}>{tender.status}</Badge>
              {tender.resultOn && (
                <span className="ml-2 text-fg-muted">{formatDate(tender.resultOn)}</span>
              )}
            </dd>
            {tender.resultCategory && (
              <>
                <dt className="text-fg-muted">Main reason</dt>
                <dd>{CATEGORY[tender.resultCategory]}</dd>
              </>
            )}
            {tender.awardedTo && (
              <>
                <dt className="text-fg-muted">Won by</dt>
                <dd>{tender.awardedTo.name}</dd>
              </>
            )}
            {tender.awardedValue && (
              <>
                <dt className="text-fg-muted">
                  {tender.status === 'won' ? 'Contract value' : 'Winning bid'}
                </dt>
                <dd className="tabular-nums">{formatInr(tender.awardedValue)}</dd>
              </>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}

/** Tabs of the tender page below the header. */
export function TenderWorkTabs({
  tender,
  overview,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  overview: ReactNode;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const work = useTenderWork(tender.id);
  const [tab, setTab] = useState<
    | 'overview'
    | 'documents'
    | 'programme'
    | 'queries'
    | 'securities'
    | 'checklist'
    | 'rfqs'
    | 'submission'
  >('overview');
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['tender-work', tender.id] });
    onChanged();
  };
  const w = work.data;
  const required = w?.checklist.filter((c) => c.required) ?? [];
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'documents', label: 'Documents' },
    { key: 'programme', label: 'Programme' },
    {
      key: 'queries',
      label: `Queries & addenda${w ? ` (${w.queries.length + w.addenda.length})` : ''}`,
    },
    { key: 'securities', label: `EMD & guarantees${w ? ` (${w.securities.length})` : ''}` },
    {
      key: 'checklist',
      label: `Checklist${w && required.length ? ` (${required.filter((c) => c.status !== 'pending').length}/${required.length})` : ''}`,
    },
    { key: 'rfqs', label: 'RFQs' },
    { key: 'submission', label: 'Submission & result' },
  ] as const;
  return (
    <div className="space-y-5">
      <div
        className="flex flex-wrap gap-1 border-b border-line"
        role="tablist"
        aria-label="Tender sections"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === t.key
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? (
        overview
      ) : tab === 'documents' ? (
        <TenderDocuments tenderId={tender.id} />
      ) : tab === 'programme' ? (
        <TenderProgrammes tenderId={tender.id} />
      ) : tab === 'rfqs' ? (
        <TenderRfqs tenderId={tender.id} />
      ) : work.isPending ? (
        <Spinner />
      ) : work.isError ? (
        <Alert tone="danger">{describeError(work.error)}</Alert>
      ) : tab === 'queries' ? (
        <QueriesAndAddenda tender={tender} work={work.data} canEdit={canEdit} onChanged={changed} />
      ) : tab === 'securities' ? (
        <Securities tender={tender} work={work.data} canEdit={canEdit} onChanged={changed} />
      ) : tab === 'checklist' ? (
        <Checklist tender={tender} work={work.data} canEdit={canEdit} onChanged={changed} />
      ) : (
        <SubmissionAndResult
          tender={tender}
          work={work.data}
          canEdit={canEdit}
          onChanged={changed}
        />
      )}
    </div>
  );
}
