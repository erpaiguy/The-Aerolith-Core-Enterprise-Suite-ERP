// Staff side of the portals (docs/wave6-plan.md step 5): invite vendors, subcontractors and clients (free, within a
// fair-use cap per kind), send them the link, deactivate them; and check what they send before it counts.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, saveFile } from '../../api/client';
import { describeError } from '../../lib/format';
import { useSession } from '../../session/session';

type Kind = 'vendor' | 'subcontractor' | 'client';
const KINDS: [Kind, string][] = [
  ['vendor', 'Vendor'],
  ['subcontractor', 'Subcontractor'],
  ['client', 'Client'],
];

interface PortalUsers {
  cap: number;
  inUse: Record<Kind, number>;
  users: {
    id: string;
    kind: Kind;
    email: string;
    name: string;
    status: string;
    party: string;
    lastLoginAt: string | null;
    inviteExpiresAt: string | null;
  }[];
}

export function PortalUsersScreen() {
  const qc = useQueryClient();
  const { entitlement } = useSession();
  const tenant = entitlement?.ten ?? '';
  const q = useQuery({
    queryKey: ['portal-users'],
    queryFn: () => api.request<PortalUsers>('/api/tenant/portal-users'),
  });
  const [form, setForm] = useState<{ kind: Kind; partyId: string; email: string; name: string }>({
    kind: 'vendor',
    partyId: '',
    email: '',
    name: '',
  });
  const parties = useQuery({
    queryKey: ['parties', form.kind],
    queryFn: () =>
      api.request<{ id: string; name: string }[]>(`/api/tenant/parties?kind=${form.kind}`),
  });
  const [link, setLink] = useState<{ who: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linkFor = (who: string, token: string) =>
    setLink({ who, url: `${window.location.origin}/portal/${tenant}/accept#${token}` });
  const confirm = useConfirm();
  const run = async (f: () => Promise<void>, done: string) => {
    setError(null);
    try {
      await f();
      toast.success(done);
      void qc.invalidateQueries({ queryKey: ['portal-users'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Portal users"
        subtitle="Vendors, subcontractors and clients who sign in to see their own orders, bills and documents. They are free, and are not seats."
      />
      <Card title="Invite">
        <form
          aria-label="Invite to a portal"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.request<{ token: string }>('/api/tenant/portal-users', {
                method: 'POST',
                body: form,
              });
              linkFor(form.email, r.token);
              setForm({ ...form, email: '', name: '' });
            }, `${form.email} invited`);
          }}
        >
          <Field label="Portal">
            <Select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Kind, partyId: '' })}
            >
              {KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Party">
            <Select
              value={form.partyId}
              onChange={(e) => setForm({ ...form, partyId: e.target.value })}
              required
            >
              <option value="">Choose</option>
              {(parties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Person's name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Button type="submit">Invite</Button>
        </form>
        {q.data && (
          <p className="mt-3 text-sm text-fg-muted">
            Fair-use limit {q.data.cap} per kind:{' '}
            {KINDS.map(([k, l]) => `${l.toLowerCase()}s ${q.data.inUse[k]}`).join(', ')}.
          </p>
        )}
      </Card>
      {link && (
        <Alert tone="success">
          Send this link to {link.who} (by email or WhatsApp). It works once, for 7 days, and is not
          shown again:
          <Input
            readOnly
            aria-label="Invitation link"
            value={link.url}
            className="mt-2 font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="People">
        {!q.data ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Party</th>
                <th>Portal</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    <div className="text-xs text-fg-muted">{u.email}</div>
                  </td>
                  <td>{u.party}</td>
                  <td>{u.kind}</td>
                  <td>
                    <Badge
                      tone={
                        u.status === 'active'
                          ? 'success'
                          : u.status === 'invited'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {u.status}
                    </Badge>
                  </td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-IN') : '—'}</td>
                  <td className="space-x-1 whitespace-nowrap">
                    {u.status !== 'deactivated' && (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void run(async () => {
                              const r = await api.request<{ token: string }>(
                                `/api/tenant/portal-users/${u.id}/resend`,
                                {
                                  method: 'POST',
                                },
                              );
                              linkFor(u.email, r.token);
                            }, `New link made for ${u.email}`)
                          }
                        >
                          New link
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: `Deactivate ${u.name}?`,
                                body: `${u.email} can no longer sign in to the portal.`,
                                confirmLabel: 'Deactivate',
                                tone: 'danger',
                              }))
                            )
                              return;
                            void run(async () => {
                              await api.request(`/api/tenant/portal-users/${u.id}/deactivate`, {
                                method: 'POST',
                              });
                            }, `${u.name} deactivated`);
                          }}
                        >
                          Deactivate
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

interface Submission {
  id: string;
  number: string;
  kind: 'quote' | 'measurement' | 'invoice';
  status: string;
  reason: string;
  payload: Record<string, unknown>;
  fileName: string | null;
  party: string;
  submittedBy: string;
  about: string | null;
  project: string | null;
  createdAt: string;
  decidedBy: string | null;
}

function Payload({ s }: { s: Submission }) {
  const p = s.payload;
  if (s.kind === 'quote') {
    const lines = (p.lines as { lineId: string; rate: string }[]) ?? [];
    return (
      <span>
        {lines.length} rates, GST {String(p.gstPct)}%
        {p.reference ? `, ref. ${String(p.reference)}` : ''}
      </span>
    );
  }
  if (s.kind === 'measurement') {
    const lines = (p.lines as { qty: string }[]) ?? [];
    return (
      <span>
        {lines.length} line(s) measured on {String(p.measuredOn)}:{' '}
        {lines.map((l) => l.qty).join(', ')}
      </span>
    );
  }
  return (
    <span>
      Invoice {String(p.invoiceNo)} of {String(p.invoiceDate)}, ₹{String(p.amount)}
    </span>
  );
}

export function PortalSubmissionsScreen() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'submitted' | 'all'>('submitted');
  const q = useQuery({
    queryKey: ['portal-submissions', status],
    queryFn: () => api.request<Submission[]>(`/api/tenant/portal-submissions?status=${status}`),
  });
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const act = async (f: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await f();
      toast.success(done);
      void qc.invalidateQueries({ queryKey: ['portal-submissions'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Submissions from portals"
        subtitle="Quotes, measurements and invoices sent by vendors and subcontractors. Nothing counts until it is accepted here."
        actions={
          <Select
            aria-label="Show"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'submitted' | 'all')}
          >
            <option value="submitted">Waiting</option>
            <option value="all">All</option>
          </Select>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!q.data ? (
        <Spinner />
      ) : q.data.length === 0 ? (
        <EmptyState title="Nothing waiting">
          Quotes, measurements and invoices sent through the portals wait here to be accepted.
        </EmptyState>
      ) : (
        <ul className="space-y-3" aria-label="Submissions">
          {q.data.map((s) => (
            <li key={s.id}>
              <Card
                title={`${s.number} · ${s.kind} from ${s.party}`}
                actions={
                  <Badge
                    tone={
                      s.status === 'accepted'
                        ? 'success'
                        : s.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {s.status}
                  </Badge>
                }
              >
                <p className="text-sm">
                  {s.about && <strong>{s.about} </strong>}
                  {s.project && <span className="text-fg-muted">({s.project}) </span>}
                  <Payload s={s} />
                </p>
                <p className="mt-1 text-xs text-fg-muted">
                  Sent by {s.submittedBy} on {new Date(s.createdAt).toLocaleString('en-IN')}
                  {s.decidedBy && `; ${s.status} by ${s.decidedBy}`} {s.reason && `: ${s.reason}`}
                </p>
                {s.fileName && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .download(`/api/tenant/portal-submissions/${s.id}/file`)
                        .then(({ blob, fileName }) => saveFile(blob, fileName))
                    }
                  >
                    Open {s.fileName}
                  </Button>
                )}
                {s.status === 'submitted' && (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Button
                      onClick={() =>
                        void act(
                          () =>
                            api.request(`/api/tenant/portal-submissions/${s.id}/accept`, {
                              method: 'POST',
                            }),
                          `${s.number} accepted`,
                        )
                      }
                    >
                      Accept
                    </Button>
                    <Field label="Why rejected">
                      <Input
                        value={reason[s.id] ?? ''}
                        onChange={(e) => setReason({ ...reason, [s.id]: e.target.value })}
                      />
                    </Field>
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: `Reject ${s.number}?`,
                            body: `${s.party} sees it as rejected, with the reason given.`,
                            confirmLabel: `Reject the ${s.kind}`,
                            tone: 'danger',
                          }))
                        )
                          return;
                        void act(
                          () =>
                            api.request(`/api/tenant/portal-submissions/${s.id}/reject`, {
                              method: 'POST',
                              body: { reason: reason[s.id] ?? '' },
                            }),
                          `${s.number} rejected`,
                        );
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
