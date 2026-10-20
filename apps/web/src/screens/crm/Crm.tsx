// The CRM (docs/wave6-plan.md step 1): the pipeline (by stage, by expected month, by source; leads going cold and
// follow-ups due), the leads with one lead's interactions and conversion to a tender, and the clients' contacts.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Textarea,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { describeError, formatInr } from '../../lib/format';
import { useFocusForm, useNewParam } from '../../lib/new-param';
import { numberLocale } from '../../lib/locale';

const STAGES = [
  'new',
  'qualified',
  'proposal',
  'negotiation',
  'tender',
  'won',
  'lost',
  'dropped',
] as const;
const SOURCES = ['referral', 'repeat_client', 'website', 'cold_call', 'event', 'portal', 'other'];
const SEGMENTS = ['buildings', 'interiors', 'joinery', 'mep', 'real_estate', 'other'];
const words = (s: string) => s.replace('_', ' ');
const tone = (s: string) =>
  s === 'won'
    ? 'success'
    : s === 'lost' || s === 'dropped'
      ? 'danger'
      : s === 'new'
        ? 'neutral'
        : 'accent';

interface Lead {
  id: string;
  number: string;
  title: string;
  partyId: string | null;
  party: string | null;
  organisation: string | null;
  source: string;
  segment: string;
  location: string;
  value: string | null;
  probability: number;
  weighted: string;
  expectedMonth: string | null;
  stage: string;
  reason: string;
  owner: string;
  tenderId: string | null;
  tender: string | null;
  goingCold: boolean;
  rowVersion: number;
}
interface LeadDetail extends Lead {
  notes: string;
  interactions: {
    id: string;
    kind: string;
    happenedAt: string;
    summary: string;
    by: string;
    followUpOn: string | null;
    followUp: string;
    followUpDoneAt: string | null;
    overdue: boolean;
  }[];
  mayEdit: boolean;
}
interface Pipeline {
  totals: { open: number; value: string; weighted: string };
  byStage: { stage: string; count: number; value: string; weighted: string }[];
  byMonth: { month: string; count: number; weighted: string }[];
  bySource: {
    source: string;
    leads: number;
    won: number;
    closed: number;
    winRate: number | null;
  }[];
  goingCold: { id: string; number: string; title: string; owner: string }[];
  followUps: {
    id: string;
    leadId: string;
    number: string;
    title: string;
    on: string;
    what: string;
    overdue: boolean;
  }[];
}

type Tab = 'pipeline' | 'leads' | 'contacts';

export function CrmScreen() {
  useFocusForm('New lead', useNewParam('lead'));
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('pipeline');
  const [open, setOpen] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('lead'),
  );
  const [error, setError] = useState<string | null>(null);
  const call = async <T,>(path: string, body: object, done?: string) => {
    setError(null);
    try {
      const r = await api.request<T>(path, { method: 'POST', body });
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['crm'] });
      return r;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="CRM"
        subtitle="Leads before they are tenders: who, what, when, and how likely."
      />
      <div role="tablist" className="flex gap-1">
        {(
          [
            ['pipeline', 'Pipeline'],
            ['leads', 'Leads'],
            ['contacts', 'Contacts'],
          ] as const
        ).map(([k, label]) => (
          <Button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            variant={tab === k ? 'primary' : 'ghost'}
            onClick={() => setTab(k)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {open && <LeadCard key={open} id={open} call={call} onClose={() => setOpen(null)} />}
      {tab === 'pipeline' ? (
        <PipelineView onOpen={setOpen} />
      ) : tab === 'leads' ? (
        <Leads onOpen={setOpen} call={call} />
      ) : (
        <Contacts call={call} />
      )}
    </div>
  );
}

function PipelineView({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['crm', 'pipeline'],
    queryFn: () => api.request<Pipeline>('/api/tenant/crm/pipeline'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const p = q.data;
  return (
    <>
      <Card title="Open pipeline">
        <p className="text-sm" data-testid="pipeline-totals">
          {p.totals.open} open · {formatInr(p.totals.value)} · weighted{' '}
          {formatInr(p.totals.weighted)}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-4" aria-label="By stage">
          {p.byStage.map((s) => (
            <div
              key={s.stage}
              className="rounded border border-line p-2 text-sm"
              aria-label={s.stage}
            >
              <div className="font-medium capitalize">{s.stage}</div>
              <div>
                {s.count} · {formatInr(s.value)}
              </div>
              <div className="text-xs text-fg-muted">weighted {formatInr(s.weighted)}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Expected by month (weighted)">
        <ul className="grid gap-1 text-sm sm:grid-cols-4">
          {p.byMonth.map((m) => (
            <li key={m.month}>
              {m.month}: {m.count ? `${m.count} · ${formatInr(m.weighted)}` : '—'}
            </li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Follow-ups">
          <ul className="space-y-1 text-sm" aria-label="Follow-ups">
            {p.followUps.map((f) => (
              <li key={f.id} className={f.overdue ? 'text-danger' : ''}>
                <button type="button" className="underline" onClick={() => onOpen(f.leadId)}>
                  {f.number}
                </button>{' '}
                {f.on}: {f.what || 'follow up'}
              </li>
            ))}
            {p.followUps.length === 0 && <li className="text-fg-muted">None due.</li>}
          </ul>
        </Card>
        <Card title="Going cold (30 days untouched)">
          <ul className="space-y-1 text-sm">
            {p.goingCold.map((g) => (
              <li key={g.id}>
                <button type="button" className="underline" onClick={() => onOpen(g.id)}>
                  {g.number}
                </button>{' '}
                {g.title} · {g.owner}
              </li>
            ))}
            {p.goingCold.length === 0 && <li className="text-fg-muted">None.</li>}
          </ul>
        </Card>
        <Card title="By source">
          <ul className="space-y-1 text-sm">
            {p.bySource.map((s) => (
              <li key={s.source}>
                {words(s.source)}: {s.leads} leads, {s.won} won
                {s.winRate !== null && ` (${s.winRate}% of closed)`}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function Leads({
  onOpen,
  call,
}: {
  onOpen: (id: string) => void;
  call: <T>(path: string, body: object, done?: string) => Promise<T | null>;
}) {
  const [stage, setStage] = useState('');
  const q = useQuery({
    queryKey: ['crm', 'leads', stage],
    queryFn: () => api.request<Lead[]>(`/api/tenant/crm/leads${stage ? `?stage=${stage}` : ''}`),
  });
  const parties = useQuery({
    queryKey: ['crm', 'clients'],
    queryFn: () => api.request<{ id: string; name: string }[]>('/api/tenant/parties?kind=client'),
  });
  const blank = {
    title: '',
    who: '',
    organisation: '',
    source: 'referral',
    segment: 'buildings',
    location: '',
    value: '',
    expectedMonth: '',
  };
  const [f, setF] = useState(blank);
  return (
    <>
      <Card title="Leads">
        <Select
          aria-label="Stage"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          className="mb-2 max-w-xs"
        >
          <option value="">Every stage</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        {q.isPending ? (
          <Spinner />
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Client</th>
                <th>Stage</th>
                <th className="text-right">Value</th>
                <th className="text-right">Weighted</th>
                <th>Expected</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((l) => (
                <tr key={l.id} aria-label={l.number}>
                  <td>
                    <button type="button" className="underline" onClick={() => onOpen(l.id)}>
                      {l.number}
                    </button>{' '}
                    {l.title} {l.goingCold && <Badge tone="warning">cold</Badge>}
                  </td>
                  <td>{l.party ?? l.organisation}</td>
                  <td>
                    <Badge tone={tone(l.stage)}>{l.stage}</Badge>
                    {l.tender && <span className="text-xs text-fg-muted"> {l.tender}</span>}
                  </td>
                  <td className="text-right tabular-nums">{l.value ? formatInr(l.value) : '—'}</td>
                  <td className="text-right tabular-nums">{formatInr(l.weighted)}</td>
                  <td>{l.expectedMonth ?? '—'}</td>
                  <td>{l.owner}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="New lead">
        <form
          aria-label="New lead"
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await call<{ id: string }>(
              '/api/tenant/crm/leads',
              {
                title: f.title,
                partyId: f.who && f.who !== 'new' ? f.who : null,
                organisation: f.who === 'new' || !f.who ? f.organisation : null,
                source: f.source,
                segment: f.segment,
                location: f.location,
                value: f.value || null,
                expectedMonth: f.expectedMonth || null,
              },
              `Lead ${f.title} added`,
            );
            if (r) {
              setF(blank);
              onOpen(r.id);
            }
          }}
        >
          <div className="sm:col-span-2">
            <Field label="What">
              <Input
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                required
                minLength={3}
              />
            </Field>
          </div>
          <Field label="Client">
            <Select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
              <option value="">A new organisation…</option>
              {(parties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {!f.who && (
            <Field label="Organisation">
              <Input
                value={f.organisation}
                onChange={(e) => setF({ ...f, organisation: e.target.value })}
                required
                minLength={2}
              />
            </Field>
          )}
          <Field label="Source">
            <Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {words(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Segment">
            <Select value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })}>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {words(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Location">
            <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          </Field>
          <Field label="Value (₹)">
            <Input
              inputMode="decimal"
              value={f.value}
              onChange={(e) => setF({ ...f, value: e.target.value })}
            />
          </Field>
          <Field label="Expected month">
            <Input
              type="month"
              value={f.expectedMonth}
              onChange={(e) => setF({ ...f, expectedMonth: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add lead</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function LeadCard({
  id,
  call,
  onClose,
}: {
  id: string;
  call: <T>(path: string, body: object, done?: string) => Promise<T | null>;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ['crm', 'lead', id],
    queryFn: () => api.request<LeadDetail>(`/api/tenant/crm/leads/${id}`),
  });
  const blank = { kind: 'call', summary: '', followUpOn: '', followUp: '' };
  const [i, setI] = useState(blank);
  const [reason, setReason] = useState('');
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const l = q.data;
  const move = async (stage: string) => {
    if (
      (stage === 'lost' || stage === 'dropped') &&
      !(await confirm({
        title: `Mark ${l.number} ${stage}?`,
        body: 'The lead closes and leaves the pipeline. The reason typed is kept with it.',
        confirmLabel: stage === 'lost' ? 'Mark it lost' : 'Drop the lead',
        tone: 'danger',
      }))
    )
      return null;
    return call(
      `/api/tenant/crm/leads/${id}/stage`,
      { stage, reason },
      `${l.number} moved to ${stage}`,
    );
  };
  const closed = ['won', 'lost', 'dropped', 'tender'].includes(l.stage);
  return (
    <Card title={`${l.number} ${l.title}`}>
      <p className="text-sm" data-testid="lead-status">
        {l.party ?? l.organisation} · <Badge tone={tone(l.stage)}>{l.stage}</Badge> ·{' '}
        {l.value ? formatInr(l.value) : 'no value'} at {l.probability}% = {formatInr(l.weighted)}
        {l.tender && ` · tender ${l.tender}`}
        {l.reason && ` · ${l.reason}`}
      </p>
      {l.mayEdit && !closed && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {(['qualified', 'proposal', 'negotiation', 'won'] as const)
            .filter((s) => s !== l.stage)
            .map((s) => (
              <Button key={s} type="button" variant="secondary" onClick={() => void move(s)}>
                Move to {s}
              </Button>
            ))}
          {['qualified', 'proposal', 'negotiation'].includes(l.stage) && (
            <Button
              type="button"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: `Make ${l.number} a tender?`,
                    body: 'A tender is opened from this lead, and the lead closes as passed to tendering.',
                    confirmLabel: 'Make it a tender',
                    tone: 'primary',
                  }))
                )
                  return;
                void call(`/api/tenant/crm/leads/${id}/convert`, {}, `${l.number} made a tender`);
              }}
            >
              Make it a tender
            </Button>
          )}
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button type="button" variant="ghost" onClick={() => void move('lost')}>
            Lost
          </Button>
          <Button type="button" variant="ghost" onClick={() => void move('dropped')}>
            Dropped
          </Button>
        </div>
      )}
      <ul className="mt-4 space-y-2 text-sm" aria-label="Interactions">
        {l.interactions.map((x) => (
          <li key={x.id} className="border-l-2 border-line pl-2">
            <span className="font-medium">{words(x.kind)}</span>{' '}
            <span className="text-fg-muted">
              {new Date(x.happenedAt).toLocaleString(numberLocale())} · {x.by}
            </span>
            <p className="whitespace-pre-wrap">{x.summary}</p>
            {x.followUpOn && (
              <p className={x.overdue ? 'text-danger' : 'text-fg-muted'}>
                Follow-up {x.followUpOn}: {x.followUp || '—'}{' '}
                {x.followUpDoneAt ? (
                  <Badge tone="success">done</Badge>
                ) : (
                  l.mayEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        void call(
                          `/api/tenant/crm/follow-ups/${x.id}/done`,
                          {},
                          'Follow-up marked done',
                        )
                      }
                    >
                      Done
                    </Button>
                  )
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
      {l.mayEdit && (
        <form
          aria-label="Log an interaction"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await call(
                `/api/tenant/crm/leads/${id}/interactions`,
                {
                  kind: i.kind,
                  happenedAt: new Date().toISOString(),
                  summary: i.summary,
                  followUpOn: i.followUpOn || null,
                  followUp: i.followUp,
                },
                'Interaction logged',
              )
            )
              setI(blank);
          }}
        >
          <Field label="Kind">
            <Select value={i.kind} onChange={(e) => setI({ ...i, kind: e.target.value })}>
              {['call', 'meeting', 'site_visit', 'email', 'note'].map((k) => (
                <option key={k} value={k}>
                  {words(k)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-3">
            <Field label="What happened">
              <Textarea
                value={i.summary}
                onChange={(e) => setI({ ...i, summary: e.target.value })}
                rows={2}
                required
              />
            </Field>
          </div>
          <Field label="Follow up on">
            <Input
              type="date"
              value={i.followUpOn}
              onChange={(e) => setI({ ...i, followUpOn: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Next step">
              <Input
                value={i.followUp}
                onChange={(e) => setI({ ...i, followUp: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button type="submit">Log</Button>
          </div>
        </form>
      )}
      <Button type="button" variant="ghost" className="mt-2" onClick={onClose}>
        Close
      </Button>
    </Card>
  );
}

function Contacts({
  call,
}: {
  call: <T>(path: string, body: object, done?: string) => Promise<T | null>;
}) {
  const q = useQuery({
    queryKey: ['crm', 'contacts'],
    queryFn: () =>
      api.request<
        { id: string; party: string; name: string; role: string; phone: string; email: string }[]
      >('/api/tenant/crm/contacts'),
  });
  const parties = useQuery({
    queryKey: ['crm', 'clients'],
    queryFn: () => api.request<{ id: string; name: string }[]>('/api/tenant/parties?kind=client'),
  });
  const blank = { partyId: '', name: '', role: '', phone: '', email: '' };
  const [f, setF] = useState(blank);
  return (
    <Card title="Contacts">
      <ul className="space-y-1 text-sm" aria-label="Contacts">
        {(q.data ?? []).map((c) => (
          <li key={c.id}>
            <span className="font-medium">{c.name}</span>{' '}
            <span className="text-fg-muted">
              {c.role && `${c.role}, `}
              {c.party}
              {c.phone && ` · ${c.phone}`}
              {c.email && ` · ${c.email}`}
            </span>
          </li>
        ))}
        {q.data?.length === 0 && (
          <li>
            <EmptyState title="None yet">
              Add a client&apos;s people with the New contact form below.
            </EmptyState>
          </li>
        )}
      </ul>
      <form
        aria-label="New contact"
        className="mt-3 grid gap-3 sm:grid-cols-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call('/api/tenant/crm/contacts', f, `Contact ${f.name} added`)) setF(blank);
        }}
      >
        <Field label="Client">
          <Select
            value={f.partyId}
            onChange={(e) => setF({ ...f, partyId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(parties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Role">
          <Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Add</Button>
        </div>
      </form>
    </Card>
  );
}
