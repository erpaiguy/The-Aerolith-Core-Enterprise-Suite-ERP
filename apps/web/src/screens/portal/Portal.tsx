// The portal for vendors, subcontractors and clients (docs/wave6-plan.md step 5), at /portal/<tenant>. A small shell
// of its own: their own sign-in and session, and only what their party may see. Quotes, measurements and invoices are
// sent for staff to accept; acknowledging an order or a transmittal is their own act.
import {
  Alert,
  AuthLayout,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Textarea,
} from '@aerolith/ui';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { saveFile } from '../../api/client';
import { describeError } from '../../lib/format';
import { PortalClient, type PortalSession } from './portalClient';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const rupees = (v: string | null | undefined) =>
  v == null || v === ''
    ? '—'
    : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const trimQty = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  accepted: 'success',
  submitted: 'warning',
  rejected: 'danger',
  acknowledged: 'success',
  issued: 'warning',
  certified: 'success',
};
const Status = ({ s }: { s: string }) => <Badge tone={STATUS_TONE[s] ?? 'neutral'}>{s}</Badge>;

interface Submission {
  id: string;
  number: string;
  kind: string;
  status: string;
  reason: string;
  about: string | null;
  createdAt: string;
}

export function PortalScreen({ tenant }: { tenant: string }) {
  const client = useMemo(() => new PortalClient(tenant), [tenant]);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const [session, setSession] = useState<PortalSession | null | 'loading'>('loading');
  useEffect(() => {
    client.onSignedOut = () => setSession(null);
    client.refresh().then(setSession, () => setSession(null));
  }, [client]);

  if (session === 'loading') return <Spinner label="Opening the portal" />;
  if (!session) return <PortalSignIn client={client} onSignedIn={setSession} />;
  return (
    <QueryClientProvider client={queryClient}>
      <PortalHome
        client={client}
        session={session}
        onSignOut={() => void client.signOut().then(() => setSession(null))}
      />
    </QueryClientProvider>
  );
}

function PortalSignIn({
  client,
  onSignedIn,
}: {
  client: PortalClient;
  onSignedIn: (s: PortalSession) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await client.auth('login', { email, password }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      title="Supplier and client portal"
      subtitle="Sign in with the email you were invited on."
    >
      <form className="space-y-4" onSubmit={(e) => void submit(e)} aria-label="Portal sign-in">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" disabled={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

/** The invitation link: choose a password, then straight in. */
export function PortalAcceptScreen({ tenant }: { tenant: string }) {
  const token = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
  const client = useMemo(() => new PortalClient(tenant), [tenant]);
  const [invite, setInvite] = useState<{
    email: string;
    name: string;
    party: string;
    kind: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/portal/auth/invitation?tenant=${tenant}&token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = (await r.json()) as {
          email: string;
          name: string;
          party: string;
          kind: string;
          message?: string;
        };
        if (!r.ok) throw new Error(body.message ?? 'This link is not valid.');
        setInvite(body);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'This link is not valid.'));
  }, [tenant, token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords differ.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.auth('accept', { token, password });
      window.location.replace(`/portal/${tenant}`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      title="Set up your portal account"
      subtitle={invite ? `${invite.name}, ${invite.party}` : ''}
    >
      {!invite && !error && <Spinner />}
      {invite && (
        <form className="space-y-4" onSubmit={(e) => void submit(e)} aria-label="Accept invitation">
          <p className="text-sm text-fg-muted">
            You will sign in as <strong>{invite.email}</strong>.
          </p>
          <Field label="New password" hint="At least 10 characters.">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="Repeat the password">
            <Input
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={busy} className="w-full">
            Set password and open the portal
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </AuthLayout>
  );
}

type Tab = 'enquiries' | 'orders' | 'bills' | 'submissions' | 'projects' | 'transmittals';

function PortalHome({
  client,
  session,
  onSignOut,
}: {
  client: PortalClient;
  session: PortalSession;
  onSignOut: () => void;
}) {
  const kind = session.user.kind;
  const tabs: [Tab, string][] =
    kind === 'client'
      ? [
          ['projects', 'Projects'],
          ['transmittals', 'Transmittals'],
        ]
      : [
          ['enquiries', 'Enquiries'],
          ['orders', kind === 'subcontractor' ? 'Work orders' : 'Orders'],
          ['bills', 'Bills and payments'],
          ['submissions', 'What I sent'],
        ];
  const [tab, setTab] = useState<Tab>(tabs[0]![0]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
        <div>
          <div className="text-sm font-semibold">{session.user.party}</div>
          <div className="text-xs text-fg-muted">
            {session.user.name} · {kind} portal
          </div>
        </div>
        <Button variant="ghost" onClick={onSignOut}>
          Sign out
        </Button>
      </header>
      <nav
        className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-4 md:px-6"
        role="tablist"
      >
        {tabs.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            type="button"
            onClick={() => {
              setTab(t);
              setOpen(null);
            }}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-medium' : 'border-transparent text-fg-muted'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6 md:px-6">
        {!session.licence.featuresUnlocked && (
          <Alert tone="warning">The portal is read-only at the moment.</Alert>
        )}
        {tab === 'enquiries' &&
          (open ? (
            <Enquiry client={client} id={open} back={() => setOpen(null)} />
          ) : (
            <Enquiries client={client} onOpen={setOpen} />
          ))}
        {tab === 'orders' &&
          (open ? (
            <Order client={client} id={open} kind={kind} back={() => setOpen(null)} />
          ) : (
            <Orders client={client} onOpen={setOpen} />
          ))}
        {tab === 'bills' && <Bills client={client} />}
        {tab === 'submissions' && <Submissions client={client} />}
        {tab === 'projects' &&
          (open ? (
            <ClientProject client={client} id={open} back={() => setOpen(null)} />
          ) : (
            <ClientProjects client={client} onOpen={setOpen} />
          ))}
        {tab === 'transmittals' &&
          (open ? (
            <Transmittal client={client} id={open} back={() => setOpen(null)} />
          ) : (
            <Transmittals client={client} onOpen={setOpen} />
          ))}
      </main>
    </div>
  );
}

function Loading<T>({
  q,
  children,
}: {
  q: { data: T | undefined; error: unknown; isLoading: boolean };
  children: (d: T) => ReactNode;
}) {
  if (q.error) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  if (q.isLoading || q.data === undefined) return <Spinner />;
  return <>{children(q.data)}</>;
}

const Back = ({ back }: { back: () => void }) => (
  <Button variant="ghost" onClick={back}>
    ← Back
  </Button>
);

// --- vendor and subcontractor ---

function Enquiries({ client, onOpen }: { client: PortalClient; onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['portal', 'enquiries'],
    queryFn: () =>
      client.get<
        {
          id: string;
          number: string;
          title: string;
          dueOn: string | null;
          lines: number;
          lastSubmission: string | null;
        }[]
      >('/enquiries'),
  });
  return (
    <Card title="Enquiries sent to you">
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No open enquiries.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Enquiry</th>
                  <th>Due</th>
                  <th>Lines</th>
                  <th>Your quote</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="text-accent underline"
                        onClick={() => onOpen(r.id)}
                      >
                        {r.number} {r.title}
                      </button>
                    </td>
                    <td>{r.dueOn ?? '—'}</td>
                    <td>{r.lines}</td>
                    <td>{r.lastSubmission ? <Status s={r.lastSubmission} /> : 'Not sent'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </Loading>
    </Card>
  );
}

function Enquiry({ client, id, back }: { client: PortalClient; id: string; back: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['portal', 'enquiry', id],
    queryFn: () =>
      client.get<{
        number: string;
        title: string;
        dueOn: string | null;
        lines: {
          id: string;
          seq: number;
          description: string;
          unit: string | null;
          qty: string | null;
          myRate: string | null;
        }[];
        submissions: Submission[];
      }>(`/enquiries/${id}`),
  });
  const [rates, setRates] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [gstPct, setGstPct] = useState('18');
  const [validUntil, setValidUntil] = useState('');
  const [terms, setTerms] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const lines = Object.entries(rates)
        .filter(([, r]) => r.trim())
        .map(([lineId, rate]) => ({ lineId, rate: rate.trim() }));
      const s = await client.post<Submission>(`/enquiries/${id}/quote`, {
        reference,
        gstPct,
        terms,
        validUntil: validUntil || null,
        lines,
      });
      setSent(s.number);
      void qc.invalidateQueries({ queryKey: ['portal'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Loading q={q}>
      {(e) => (
        <div className="space-y-4">
          <Back back={back} />
          <Card title={`${e.number} ${e.title}`}>
            <p className="mb-3 text-sm text-fg-muted">
              Due {e.dueOn ?? 'when you can'}. Rates before GST.
            </p>
            <form onSubmit={(ev) => void submit(ev)} aria-label="Quote" className="space-y-3">
              <Table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Your rate ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {e.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.seq}</td>
                      <td>{l.description}</td>
                      <td>
                        {l.qty ? trimQty(l.qty) : '—'} {l.unit}
                      </td>
                      <td>
                        <Input
                          aria-label={`Rate for ${l.description}`}
                          inputMode="decimal"
                          value={rates[l.id] ?? (l.myRate ? trimQty(l.myRate) : '')}
                          onChange={(ev) => setRates({ ...rates, [l.id]: ev.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Your reference">
                  <Input value={reference} onChange={(ev) => setReference(ev.target.value)} />
                </Field>
                <Field label="GST %">
                  <Select value={gstPct} onChange={(ev) => setGstPct(ev.target.value)}>
                    {['0', '5', '12', '18', '28'].map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Valid until">
                  <Input
                    type="date"
                    min={today()}
                    value={validUntil}
                    onChange={(ev) => setValidUntil(ev.target.value)}
                  />
                </Field>
              </div>
              <Field label="Terms">
                <Textarea rows={2} value={terms} onChange={(ev) => setTerms(ev.target.value)} />
              </Field>
              {error && <Alert tone="danger">{error}</Alert>}
              {sent && (
                <Alert tone="success">
                  <span data-testid="quote-sent">
                    Quote {sent} sent. It counts once the buyer accepts it.
                  </span>
                </Alert>
              )}
              <Button type="submit">Send quote</Button>
            </form>
          </Card>
          <SubmissionList rows={e.submissions} />
        </div>
      )}
    </Loading>
  );
}

function Orders({ client, onOpen }: { client: PortalClient; onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['portal', 'orders'],
    queryFn: () =>
      client.get<
        {
          id: string;
          number: string;
          status: string;
          project: string;
          total: string;
          deliverBy: string | null;
        }[]
      >('/orders'),
  });
  return (
    <Card title="Your orders">
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No orders yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Project</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="text-accent underline"
                        onClick={() => onOpen(r.id)}
                      >
                        {r.number}
                      </button>
                    </td>
                    <td>{r.project}</td>
                    <td className="tabular-nums">{rupees(r.total)}</td>
                    <td>
                      <Status s={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </Loading>
    </Card>
  );
}

interface OrderDetail {
  id: string;
  number: string;
  status: string;
  project: string;
  deliverBy: string | null;
  paymentTerms: string;
  total: string;
  acknowledgedOn: string | null;
  acknowledgedRef: string | null;
  lines: {
    lineKey: string;
    position: number;
    description: string;
    unit: string;
    qty: string;
    rate: string;
    amount: string;
    measured: string;
  }[];
  mayAcknowledge: boolean;
  submissions: Submission[];
}

function Order({
  client,
  id,
  kind,
  back,
}: {
  client: PortalClient;
  id: string;
  kind: string;
  back: () => void;
}) {
  const qc = useQueryClient();
  const key = ['portal', 'order', id];
  const q = useQuery({ queryKey: key, queryFn: () => client.get<OrderDetail>(`/orders/${id}`) });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await f();
      setNotice(done);
      void qc.invalidateQueries({ queryKey: ['portal'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const [invoice, setInvoice] = useState({ invoiceNo: '', invoiceDate: today(), amount: '' });
  const [file, setFile] = useState<File | null>(null);
  const [measured, setMeasured] = useState<Record<string, string>>({});
  return (
    <Loading q={q}>
      {(o) => (
        <div className="space-y-4">
          <Back back={back} />
          <Card
            title={`${o.number} · ${o.project}`}
            actions={
              o.mayAcknowledge && (
                <Button
                  onClick={() =>
                    void run(
                      () => client.post(`/orders/${id}/acknowledge`, {}),
                      'Order acknowledged.',
                    )
                  }
                >
                  Acknowledge the order
                </Button>
              )
            }
          >
            <p className="mb-3 text-sm text-fg-muted">
              <Status s={o.status} /> {o.acknowledgedOn && `Acknowledged on ${o.acknowledgedOn}. `}
              {o.deliverBy && `Deliver by ${o.deliverBy}. `}
              {o.paymentTerms}
            </p>
            <Table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th>Amount</th>
                  {kind === 'subcontractor' && <th>Measured</th>}
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.lineKey}>
                    <td>{l.position}</td>
                    <td>{l.description}</td>
                    <td>
                      {trimQty(l.qty)} {l.unit}
                    </td>
                    <td className="tabular-nums">{rupees(l.rate)}</td>
                    <td className="tabular-nums">{rupees(l.amount)}</td>
                    {kind === 'subcontractor' && (
                      <td className="tabular-nums">{trimQty(l.measured)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2 text-right text-sm font-medium">Total with GST {rupees(o.total)}</p>
          </Card>
          {error && <Alert tone="danger">{error}</Alert>}
          {notice && (
            <Alert tone="success">
              <span data-testid="portal-notice">{notice}</span>
            </Alert>
          )}
          {kind === 'subcontractor' && (
            <Card title="Send a measurement">
              <form
                aria-label="Measurement"
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () =>
                      client.post(`/orders/${id}/measurements`, {
                        measuredOn: today(),
                        lines: Object.entries(measured)
                          .filter(([, v]) => v.trim())
                          .map(([lineKey, qty]) => ({ lineKey, qty: qty.trim() })),
                      }),
                    'Measurement sent for checking.',
                  );
                }}
              >
                {o.lines.map((l) => (
                  <Field
                    key={l.lineKey}
                    label={`${l.description} (${l.unit}) done since the last measurement`}
                  >
                    <Input
                      inputMode="decimal"
                      value={measured[l.lineKey] ?? ''}
                      onChange={(e) => setMeasured({ ...measured, [l.lineKey]: e.target.value })}
                    />
                  </Field>
                ))}
                <Button type="submit">Send measurement</Button>
              </form>
            </Card>
          )}
          <Card title="Send an invoice">
            <form
              aria-label="Invoice"
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!file) return;
                const qs = new URLSearchParams(invoice).toString();
                void run(
                  () => client.upload(`/orders/${id}/invoices?${qs}`, file),
                  'Invoice sent for checking.',
                );
              }}
            >
              <Field label="Invoice no.">
                <Input
                  value={invoice.invoiceNo}
                  onChange={(e) => setInvoice({ ...invoice, invoiceNo: e.target.value })}
                  required
                />
              </Field>
              <Field label="Invoice date">
                <Input
                  type="date"
                  max={today()}
                  value={invoice.invoiceDate}
                  onChange={(e) => setInvoice({ ...invoice, invoiceDate: e.target.value })}
                  required
                />
              </Field>
              <Field label="Amount ₹">
                <Input
                  inputMode="decimal"
                  value={invoice.amount}
                  onChange={(e) => setInvoice({ ...invoice, amount: e.target.value })}
                  required
                />
              </Field>
              <Field label="Invoice file (PDF or photo)">
                <Input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  required
                />
              </Field>
              <Button type="submit">Send invoice</Button>
            </form>
          </Card>
          <SubmissionList rows={o.submissions} />
        </div>
      )}
    </Loading>
  );
}

function SubmissionList({ rows }: { rows: Submission[] }) {
  if (!rows.length) return null;
  return (
    <Card title="Sent from this portal">
      <ul className="space-y-1 text-sm" aria-label="Sent from this portal">
        {rows.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.number}</span> {s.kind} {s.about && `for ${s.about}`}{' '}
            <Status s={s.status} /> {s.reason && <span className="text-fg-muted">{s.reason}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Submissions({ client }: { client: PortalClient }) {
  const q = useQuery({
    queryKey: ['portal', 'submissions'],
    queryFn: () => client.get<Submission[]>('/submissions'),
  });
  return (
    <Loading q={q}>
      {(rows) =>
        rows.length ? (
          <SubmissionList rows={rows} />
        ) : (
          <p className="text-sm text-fg-muted">Nothing sent yet.</p>
        )
      }
    </Loading>
  );
}

function Bills({ client }: { client: PortalClient }) {
  const q = useQuery({
    queryKey: ['portal', 'bills'],
    queryFn: () =>
      client.get<{
        bills: {
          billNo: string;
          billDate: string;
          order: string | null;
          payable: string;
          outstanding: string;
          status: string;
          lastPaidOn: string | null;
        }[];
        raBills: {
          order: string;
          raNo: number;
          upto: string;
          status: string;
          net: string | null;
        }[];
      }>('/bills'),
  });
  return (
    <Loading q={q}>
      {(d) => (
        <div className="space-y-4">
          <Card title="Bills and payments">
            {d.bills.length === 0 ? (
              <p className="text-sm text-fg-muted">No bills posted yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th>Order</th>
                    <th>Payable</th>
                    <th>Outstanding</th>
                    <th>Last paid</th>
                  </tr>
                </thead>
                <tbody>
                  {d.bills.map((b) => (
                    <tr key={`${b.billNo}${b.billDate}`}>
                      <td>{b.billNo}</td>
                      <td>{b.billDate}</td>
                      <td>{b.order ?? '—'}</td>
                      <td className="tabular-nums">{rupees(b.payable)}</td>
                      <td className="tabular-nums">{rupees(b.outstanding)}</td>
                      <td>{b.lastPaidOn ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {d.raBills.length > 0 && (
            <Card title="RA bills">
              <Table>
                <thead>
                  <tr>
                    <th>Work order</th>
                    <th>RA</th>
                    <th>Up to</th>
                    <th>Net</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.raBills.map((b) => (
                    <tr key={`${b.order}${b.raNo}`}>
                      <td>{b.order}</td>
                      <td>{b.raNo}</td>
                      <td>{b.upto}</td>
                      <td className="tabular-nums">{rupees(b.net)}</td>
                      <td>
                        <Status s={b.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      )}
    </Loading>
  );
}

// --- client ---

interface ProjectSummary {
  id: string;
  number: string;
  name: string;
  status: string;
  contractValue: string | null;
  billed: string;
  certified: string;
  received: string;
}

function ClientProjects({
  client,
  onOpen,
}: {
  client: PortalClient;
  onOpen: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['portal', 'projects'],
    queryFn: () => client.get<ProjectSummary[]>('/projects'),
  });
  return (
    <Card title="Your projects">
      <Loading q={q}>
        {(rows) => (
          <Table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Contract value</th>
                <th>Billed</th>
                <th>Certified</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button
                      type="button"
                      className="text-accent underline"
                      onClick={() => onOpen(p.id)}
                    >
                      {p.name}
                    </button>
                  </td>
                  <td className="tabular-nums">{rupees(p.contractValue)}</td>
                  <td className="tabular-nums">{rupees(p.billed)}</td>
                  <td className="tabular-nums">{rupees(p.certified)}</td>
                  <td className="tabular-nums">{rupees(p.received)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Loading>
    </Card>
  );
}

function PortalPhoto({
  client,
  projectId,
  id,
  caption,
}: {
  client: PortalClient;
  projectId: string;
  id: string;
  caption: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    client.blob(`/projects/${projectId}/photos/${id}`).then(
      ({ blob }) => {
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => setUrl(null),
    );
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, projectId, id]);
  return url ? (
    <img src={url} alt={caption || 'Site photo'} className="h-32 w-full rounded object-cover" />
  ) : (
    <div className="h-32 rounded bg-surface-2" />
  );
}

function ClientProject({
  client,
  id,
  back,
}: {
  client: PortalClient;
  id: string;
  back: () => void;
}) {
  const q = useQuery({
    queryKey: ['portal', 'project', id],
    queryFn: () =>
      client.get<
        ProjectSummary & {
          bills: {
            id: string;
            raNo: number;
            upto: string;
            status: string;
            submitted: string | null;
            certified: string | null;
            received: string;
          }[];
          photos: { id: string; caption: string; reportDate: string; site: string }[];
        }
      >(`/projects/${id}`),
  });
  return (
    <Loading q={q}>
      {(p) => (
        <div className="space-y-4">
          <Back back={back} />
          <Card title={p.name}>
            <Table>
              <thead>
                <tr>
                  <th>RA bill</th>
                  <th>Up to</th>
                  <th>Submitted</th>
                  <th>Certified</th>
                  <th>Paid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {p.bills.map((b) => (
                  <tr key={b.id}>
                    <td>RA {b.raNo}</td>
                    <td>{b.upto}</td>
                    <td className="tabular-nums">{rupees(b.submitted)}</td>
                    <td className="tabular-nums">{rupees(b.certified)}</td>
                    <td className="tabular-nums">{rupees(b.received)}</td>
                    <td>
                      <Status s={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title="Site photos, last 30 days">
            {p.photos.length === 0 ? (
              <p className="text-sm text-fg-muted">No photos yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {p.photos.map((ph) => (
                  <figure key={ph.id}>
                    <PortalPhoto client={client} projectId={id} id={ph.id} caption={ph.caption} />
                    <figcaption className="mt-1 text-xs text-fg-muted">
                      {ph.reportDate} · {ph.site} {ph.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </Loading>
  );
}

function Transmittals({ client, onOpen }: { client: PortalClient; onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['portal', 'transmittals'],
    queryFn: () =>
      client.get<
        {
          id: string;
          number: string;
          subject: string;
          project: string;
          status: string;
          dueOn: string | null;
        }[]
      >('/transmittals'),
  });
  return (
    <Card title="Transmittals to you">
      <Loading q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing sent to you yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {rows.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => onOpen(t.id)}
                  >
                    {t.number} {t.subject}
                  </button>
                  <span className="text-fg-muted">{t.project}</span>
                  <Status s={t.status} />
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
    </Card>
  );
}

function Transmittal({ client, id, back }: { client: PortalClient; id: string; back: () => void }) {
  const qc = useQueryClient();
  const key = ['portal', 'transmittal', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      client.get<{
        number: string;
        subject: string;
        project: string;
        purpose: string;
        status: string;
        acknowledgedBy: string | null;
        response: string | null;
        items: { id: string; name: string; versionNo: number }[];
        codes: { code: string; label: string }[];
      }>(`/transmittals/${id}`),
  });
  const [response, setResponse] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      qc.setQueryData(key, await f());
      void qc.invalidateQueries({ queryKey: ['portal', 'transmittals'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Loading q={q}>
      {(t) => (
        <div className="space-y-4">
          <Back back={back} />
          <Card
            title={`${t.number} ${t.subject}`}
            actions={
              t.status === 'issued' && (
                <Button
                  onClick={() => void act(() => client.post(`/transmittals/${id}/acknowledge`))}
                >
                  Acknowledge receipt
                </Button>
              )
            }
          >
            <p className="mb-3 text-sm text-fg-muted">
              {t.project} · <Status s={t.status} />{' '}
              {t.acknowledgedBy && `Acknowledged by ${t.acknowledgedBy}.`}
            </p>
            <ul className="space-y-1 text-sm">
              {t.items.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() =>
                      void client
                        .blob(`/transmittals/${id}/items/${it.id}`)
                        .then(({ blob, fileName }) => saveFile(blob, fileName))
                    }
                  >
                    {it.name} (version {it.versionNo})
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {t.purpose === 'review' && !t.response && t.status !== 'closed' && (
            <Card title="Your response">
              <form
                aria-label="Response"
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() =>
                    client.post(`/transmittals/${id}/respond`, { response, code: code || null }),
                  );
                }}
              >
                <Field label="Code">
                  <Select value={code} onChange={(e) => setCode(e.target.value)}>
                    <option value="">—</option>
                    {t.codes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Comments">
                  <Textarea
                    rows={3}
                    value={response}
                    onChange={(e) => setResponse(e.target.value)}
                    required
                  />
                </Field>
                <Button type="submit">Send response</Button>
              </form>
            </Card>
          )}
          {t.response && <Alert tone="info">Response recorded: {t.response}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Loading>
  );
}
