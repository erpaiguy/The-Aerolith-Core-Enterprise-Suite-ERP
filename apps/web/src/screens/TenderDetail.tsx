import { Alert, Badge, Button, Card, Field, PageHeader, Spinner, Textarea } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Pencil } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { TenderProjectCard } from './Projects';
import type { Criterion, TenderDetail, TenderStatus } from '../api/types';
import { describeError, formatDate, formatDateTime, formatInr } from '../lib/format';
import { usePermission } from '../session/permissions';
import { TenderBoqs } from './Boq';
import { TenderBidSummaryCard } from './Pricing';
import { SOURCES, TenderForm, VERTICALS } from './TenderForm';
import { ResultForm, SubmissionForm, TenderWorkTabs } from './TenderWork';
import { DueLabel, STATUS_LABEL, statusTone, useCanEditTenders } from './Tenders';

const OPEN: TenderStatus[] = ['lead', 'evaluating', 'bidding', 'submitted'];
const NEEDS_REASON: TenderStatus[] = ['lost', 'withdrawn', 'cancelled'];
/** Moves that record more than a status: the submission, and the result. */
const WITH_FORM: TenderStatus[] = ['submitted', 'won', 'lost'];

/** Button labels for each manual status move. */
const MOVE_LABEL: Record<TenderStatus, string> = {
  lead: 'Back to lead',
  evaluating: 'Start evaluating',
  bidding: 'Bidding',
  submitted: 'Mark submitted',
  won: 'Mark won',
  lost: 'Mark lost',
  no_bid: 'No bid',
  withdrawn: 'Withdraw',
  cancelled: 'Cancel tender',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Same formula as the server (tender-rules.ts bidScore): each criterion's 1..5 maps onto 0..1, weighted. */
export function bidScore(criteria: Pick<Criterion, 'weight' | 'score'>[]): number {
  const total = criteria.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return 0;
  const got = criteria.reduce((a, c) => a + c.weight * ((c.score - 1) / 4), 0);
  return Math.round((got / total) * 1000) / 10;
}

const verdict = (score: number) =>
  score >= 60
    ? { text: 'Favourable', tone: 'success' as const }
    : score >= 40
      ? { text: 'Marginal', tone: 'warning' as const }
      : { text: 'Unfavourable', tone: 'danger' as const };

function StatusActions({ tender, onChanged }: { tender: TenderDetail; onChanged: () => void }) {
  const [pending, setPending] = useState<TenderStatus | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (tender.allowedMoves.length === 0) return null;

  const move = async (to: TenderStatus) => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/tenant/tenders/${tender.id}/status`, {
        method: 'POST',
        body: { to, reason },
      });
      setPending(null);
      setReason('');
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    setPending(null);
    onChanged();
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {tender.allowedMoves.map((to) => (
          <Button
            key={to}
            type="button"
            variant={to === 'won' ? 'primary' : NEEDS_REASON.includes(to) ? 'ghost' : 'secondary'}
            busy={busy && pending === to}
            onClick={() =>
              NEEDS_REASON.includes(to) || WITH_FORM.includes(to) ? setPending(to) : void move(to)
            }
          >
            {MOVE_LABEL[to]}
          </Button>
        ))}
      </div>
      {pending === 'submitted' && (
        <SubmissionForm
          tender={tender}
          revised={false}
          onDone={done}
          onCancel={() => setPending(null)}
        />
      )}
      {(pending === 'won' || pending === 'lost') && (
        <ResultForm
          key={pending}
          tender={tender}
          outcome={pending}
          onDone={done}
          onCancel={() => setPending(null)}
        />
      )}
      {pending && !WITH_FORM.includes(pending) && (
        <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
          <Field
            label={`Reason (${STATUS_LABEL[pending].toLowerCase()})`}
            hint={
              pending === 'lost'
                ? 'For example: L2 by 1.8%, or lost on technical score.'
                : undefined
            }
          >
            <Textarea
              name="statusReason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={pending === 'lost' ? 'secondary' : 'danger'}
              busy={busy}
              disabled={reason.trim().length < 3}
              onClick={() => void move(pending)}
            >
              {MOVE_LABEL[pending]}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function BidDecision({
  tender,
  canEdit,
  onChanged,
}: {
  tender: TenderDetail;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const latest = tender.decisions[0];
  const [scores, setScores] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      tender.defaultCriteria.map((c) => [
        c.key,
        latest?.criteria.find((x) => x.key === c.key)?.score ?? 3,
      ]),
    ),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'bid' | 'no_bid' | null>(null);
  const criteria = useMemo(
    () => tender.defaultCriteria.map((c) => ({ ...c, score: scores[c.key] ?? 3 })),
    [tender.defaultCriteria, scores],
  );
  const score = bidScore(criteria);
  const v = verdict(score);
  const deciding = canEdit && tender.canDecide;

  const decide = async (decision: 'bid' | 'no_bid') => {
    setBusy(decision);
    setError(null);
    try {
      await api.request(`/api/tenant/tenders/${tender.id}/decision`, {
        method: 'POST',
        body: {
          decision,
          reason,
          criteria: criteria.map(({ key, weight, score: s }) => ({ key, weight, score: s })),
        },
      });
      setReason('');
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Bid / no-bid">
      {deciding ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Score each point from 1 (poor) to 5 (excellent) for your company. The score advises; you
            decide.
          </p>
          <ul className="space-y-2.5">
            {criteria.map((c) => (
              <li key={c.key} className="grid grid-cols-[1fr_auto] items-center gap-3">
                <span className="min-w-0 text-sm">
                  {c.label} <span className="text-xs text-fg-subtle">×{c.weight}</span>
                </span>
                <span className="flex gap-1" role="radiogroup" aria-label={c.label}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={c.score === n}
                      aria-label={`${c.label}: ${n}`}
                      onClick={() => setScores((s) => ({ ...s, [c.key]: n }))}
                      className={`size-8 rounded-md border text-sm tabular-nums ${c.score === n ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface hover:bg-surface-2'}`}
                    >
                      {n}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>
                Score{' '}
                <strong className="tabular-nums" data-testid="bid-score">
                  {score.toFixed(1)}
                </strong>{' '}
                / 100
              </span>
              <Badge tone={v.tone}>{v.text}</Badge>
            </div>
            <div className="h-2 overflow-hidden rounded bg-surface-3" aria-hidden>
              <div
                className={`h-full ${v.tone === 'success' ? 'bg-success' : v.tone === 'warning' ? 'bg-warning' : 'bg-danger'}`}
                style={{ width: `${score}%` }}
              />
            </div>
          </div>
          <Field
            label="Reason"
            hint="Required for a no-bid. Shown in the history and win/loss analysis."
          >
            <Textarea
              name="decisionReason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" busy={busy === 'bid'} onClick={() => void decide('bid')}>
              Decide: bid
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={busy === 'no_bid'}
              disabled={reason.trim().length < 3}
              onClick={() => void decide('no_bid')}
            >
              Decide: no bid
            </Button>
          </div>
        </div>
      ) : tender.decisions.length === 0 ? (
        <p className="text-sm text-fg-muted">No decision recorded yet.</p>
      ) : null}

      {tender.decisions.length > 0 && (
        <ol className={`space-y-2 text-sm ${deciding ? 'mt-5 border-t border-line pt-4' : ''}`}>
          {tender.decisions.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-2">
              <Badge tone={d.decision === 'bid' ? 'success' : 'neutral'}>
                {d.decision === 'bid' ? 'Bid' : 'No bid'}
              </Badge>
              <span className="tabular-nums">{Number(d.score).toFixed(1)}</span>
              <span className="text-fg-muted">
                {d.decidedBy}, {formatDateTime(d.decidedAt)}
              </span>
              {d.reason && <span className="w-full text-fg-muted">“{d.reason}”</span>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function describeEvent(e: TenderDetail['events'][number]): string {
  const d = e.data;
  switch (e.kind) {
    case 'created':
      return `Created ${String(d.number ?? '')}`;
    case 'updated':
      return `Edited ${Array.isArray(d.fields) ? d.fields.length : ''} field(s)`;
    case 'status_changed':
      return `${STATUS_LABEL[d.from as TenderStatus] ?? d.from} → ${STATUS_LABEL[d.to as TenderStatus] ?? d.to}${d.reason ? `: ${String(d.reason)}` : ''}`;
    case 'decision':
      return `Decided ${d.decision === 'bid' ? 'to bid' : 'not to bid'} (score ${Number(d.score).toFixed(1)})`;
    case 'boq_frozen':
      return `BOQ ${String(d.name ?? '')}: version ${String(d.version)} frozen (${d.kind === 'submitted' ? 'submitted' : 'internal review'})`;
    case 'boq_revision_started':
      return `BOQ ${String(d.name ?? '')}: revision ${String(d.version)} started${d.note ? `: ${String(d.note)}` : ''}`;
    case 'boq_archived':
      return `BOQ ${String(d.name ?? '')} archived`;
    case 'boq_restored':
      return `BOQ ${String(d.name ?? '')} restored`;
    case 'boq_imported':
      return d.mode === 'revision'
        ? `Revised BOQ imported into version ${String(d.version)} from ${String(d.file ?? '')}: ${String(d.changed)} changed, ${String(d.added)} added, ${String(d.removed)} removed, ${String(d.moved)} moved`
        : `BOQ imported from ${String(d.file ?? '')} (${String(d.lines ?? '')} lines)`;
    case 'addendum':
      return `Addendum ${String(d.ref ?? '')} recorded${d.dueAfter ? `; submission moved to ${formatDateTime(String(d.dueAfter))}` : ''}`;
    case 'query_added':
      return `Query Q${String(d.seq)} drafted`;
    case 'query_sent':
    case 'query_answered':
    case 'query_withdrawn':
      return `Query Q${String(d.seq)} ${e.kind.slice(6)}`;
    case 'security':
      return `${String(d.purpose ?? '').toUpperCase()} ${String(d.form ?? '').replace('_', ' ')} of ${formatInr(String(d.amount ?? ''))} recorded`;
    case 'security_status':
      return `EMD/BG status: ${String(d.from)} → ${String(d.to)}`;
    case 'submission':
      return `${d.kind === 'revised' ? 'Revised offer' : 'Bid'} submitted (${String(d.mode)}${d.reference ? `, ${String(d.reference)}` : ''})`;
    case 'opening':
      return `Bids recorded: ${String(d.bidders)} bidders${d.ourRank ? `, we were L${String(d.ourRank)}` : ''}`;
    case 'result':
      return `Result: ${String(d.outcome)}${d.category ? ` (${String(d.category)})` : ''}`;
    case 'programme_created':
      return `Programme started: ${String(d.name ?? '')}`;
    case 'programme_archived':
      return `Programme archived: ${String(d.name ?? '')}`;
    case 'programme_restored':
      return `Programme restored: ${String(d.name ?? '')}`;
    case 'rfq_created':
      return `${String(d.number)} started: ${String(d.title ?? '')}`;
    case 'rfq_status':
      return `${String(d.number)}: ${String(d.from)} → ${String(d.to)}`;
    case 'rfq_quote':
      return `Quote from ${String(d.vendor)} on ${String(d.number)} (${String(d.lines)} rates${d.source === 'file' ? ', from their workbook' : ''})`;
    case 'rfq_applied':
      return `Rates from ${String(d.number)} put into the estimate: ${String(d.items)} BOQ item(s), ${String(d.resources)} resource(s)`;
    default:
      return e.kind;
  }
}

export function TenderDetailScreen({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEditTenders();
  const canEditBoq = usePermission('boq.edit');
  const canPrice = usePermission('pricing.edit');
  const [editing, setEditing] = useState(false);
  const tender = useQuery({
    queryKey: ['tender', tenderId],
    queryFn: () => api.request<TenderDetail>(`/api/tenant/tenders/${tenderId}`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tender', tenderId] });
    void qc.invalidateQueries({ queryKey: ['tenders'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['tender-work', tenderId] });
    void qc.invalidateQueries({ queryKey: ['tender-boqs'] });
  };

  if (tender.isPending) return <Spinner />;
  if (tender.isError) return <Alert tone="danger">{describeError(tender.error)}</Alert>;
  const t = tender.data;
  const open = OPEN.includes(t.status);

  return (
    <div className="space-y-5">
      <Link
        to="/tenders"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tenders
      </Link>
      <PageHeader
        title={t.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{t.number}</span>
            <Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Badge>
            {t.client && <span>{t.client.name}</span>}
          </span>
        }
        actions={
          canEdit &&
          !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          )
        }
      />
      {t.statusReason && !open && <Alert tone="info">{t.statusReason}</Alert>}

      {editing ? (
        <Card title="Edit tender">
          <TenderForm
            tender={t}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              await api.request(`/api/tenant/tenders/${t.id}`, {
                method: 'POST',
                body: { ...body, rowVersion: t.rowVersion },
              });
              setEditing(false);
              refresh();
            }}
          />
        </Card>
      ) : (
        <>
          {canEdit && <StatusActions tender={t} onChanged={refresh} />}
          <TenderWorkTabs
            tender={t}
            canEdit={canEdit}
            onChanged={refresh}
            overview={
              <div className="grid gap-5 xl:grid-cols-[1fr_26rem]">
                <div className="space-y-5">
                  {t.status === 'won' && <TenderProjectCard tenderId={t.id} />}
                  <TenderBoqs tenderId={t.id} canEdit={canEditBoq} />
                  {canPrice && <TenderBidSummaryCard tenderId={t.id} />}
                  <Card title="Dates">
                    <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
                      <Row label="Submission due">
                        {t.submissionDueAt ? (
                          <>
                            {formatDateTime(t.submissionDueAt)}{' '}
                            <DueLabel iso={t.submissionDueAt} open={open} relativeOnly />
                          </>
                        ) : (
                          '-'
                        )}
                      </Row>
                      <Row label="Pre-bid meeting">
                        {t.prebidAt ? formatDateTime(t.prebidAt) : '-'}
                      </Row>
                      <Row label="Last day for queries">
                        {t.queriesDueAt ? formatDateTime(t.queriesDueAt) : '-'}
                      </Row>
                      <Row label="Bid opening">
                        {t.openingAt ? formatDateTime(t.openingAt) : '-'}
                      </Row>
                      <Row label="Published">{t.publishedOn ? formatDate(t.publishedOn) : '-'}</Row>
                      <Row label="Bid validity">
                        {t.bidValidityDays ? `${t.bidValidityDays} days` : '-'}
                      </Row>
                    </dl>
                  </Card>
                  <Card title="Details">
                    <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
                      <Row label="Estimated value">{formatInr(t.estimatedValue)}</Row>
                      <Row label="EMD">{formatInr(t.emdAmount)}</Row>
                      <Row label="Tender fee">{formatInr(t.tenderFee)}</Row>
                      <Row label="Client's number">{t.clientRef ?? '-'}</Row>
                      <Row label="Source">{SOURCES[t.source] ?? t.source}</Row>
                      <Row label="Vertical">{VERTICALS[t.vertical] ?? t.vertical}</Row>
                      <Row label="Location">{t.location ?? '-'}</Row>
                      <Row label="Owner">{t.owner?.displayName ?? '-'}</Row>
                      {t.portalUrl && (
                        <Row label="Notice">
                          <a
                            href={t.portalUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                          >
                            Open link <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        </Row>
                      )}
                    </dl>
                    {t.description && (
                      <p className="mt-4 whitespace-pre-wrap border-t border-line pt-4 text-sm">
                        {t.description}
                      </p>
                    )}
                  </Card>
                </div>
                <div className="space-y-5">
                  {/* Reset the scores only when a decision is recorded: any other change to the tender (a status
                      move, an edit) refetches it, and remounting then would drop scores being clicked. */}
                  <BidDecision
                    key={t.decisions[0]?.id ?? 'none'}
                    tender={t}
                    canEdit={canEdit}
                    onChanged={refresh}
                  />
                  <Card title="Activity">
                    <ol className="space-y-2 text-sm">
                      {t.events.map((e) => (
                        <li key={e.id}>
                          <div>{describeEvent(e)}</div>
                          <div className="text-xs text-fg-subtle">
                            {e.actor ?? 'System'}, {formatDateTime(e.createdAt)}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </Card>
                </div>
              </div>
            }
          />
        </>
      )}
    </div>
  );
}
