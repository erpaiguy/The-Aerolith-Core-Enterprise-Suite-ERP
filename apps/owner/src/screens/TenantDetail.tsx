import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type DatabaseStatus, type LicenceDetail, type TenantDetail } from '../api';
import {
  dateInputValue,
  daysUntil,
  dbTone,
  errorMessage,
  formatDate,
  formatDateTime,
  licenceTone,
} from '../format';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { PageHeader, Table } from './Shell';

const IN_PROGRESS = ['creating', 'bootstrapping', 'migrating'];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** A destructive button that needs a second click within 5 seconds. */
function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  busy,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      type="button"
      variant={armed ? 'danger' : 'secondary'}
      busy={busy ?? false}
      disabled={disabled ?? false}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          setTimeout(() => setArmed(false), 5000);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

function TrialEnd({ licence }: { licence: LicenceDetail }) {
  const [date, setDate] = useState(dateInputValue(new Date(licence.ends_at)));
  const [reason, setReason] = useState('');
  const change = useAction(
    () =>
      api.post<{ kind: string; endsAt: string }>(`/api/owner/licences/${licence.id}/trial-end`, {
        // End of the chosen day in India.
        newEndsAt: `${date}T23:59:59+05:30`,
        reason: reason.trim(),
      }),
    {
      invalidate: [['licence', licence.id], ['tenant'], ['tenants'], ['overview']],
      success: (r) =>
        `Trial ${r.kind} to ${formatDate(r.endsAt)}. The tenant was emailed and sees a notice in the app.`,
    },
  );
  const earliest =
    change.rawError instanceof ApiError && typeof change.rawError.body.earliestAllowed === 'string'
      ? change.rawError.body.earliestAllowed
      : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void change.run();
  };
  return (
    <form onSubmit={submit} className="space-y-3 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Change trial end date</h3>
      <div className="grid gap-3 md:grid-cols-[12rem_1fr]">
        <Field label="New end date">
          <Input
            name="trialEnd"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Message to the tenant (optional)" hint="Shown in the email and in the app.">
          <Input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </Field>
      </div>
      <p className="text-xs text-fg-muted">
        Extending works any time. Shortening needs at least 14 days&rsquo; notice.
      </p>
      {change.error && (
        <Alert tone="danger">
          {change.error}
          {earliest && ` The earliest allowed end date is ${formatDate(earliest)}.`}
        </Alert>
      )}
      {change.done && <Alert tone="success">{change.done}</Alert>}
      <Button type="submit" variant="secondary" busy={change.busy}>
        Save end date
      </Button>
    </form>
  );
}

function LicenceCard({ licenceId, ownerEmail }: { licenceId: string; ownerEmail: string }) {
  const { canWrite } = useSession();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const licence = useQuery({
    queryKey: ['licence', licenceId],
    queryFn: () => api.get<LicenceDetail>(`/api/owner/licences/${licenceId}`),
  });
  const invalidate = [['licence', licenceId], ['tenant'], ['tenants'], ['overview']];
  const resend = useAction(() => api.post(`/api/owner/licences/${licenceId}/resend-key`), {
    invalidate,
    success: () => `Licence key emailed to ${ownerEmail}.`,
  });
  const reveal = useAction(
    () => api.post<{ licenceKey: string }>(`/api/owner/licences/${licenceId}/reveal-key`),
    { invalidate },
  );
  const revoke = useAction(
    () => api.post(`/api/owner/licences/${licenceId}/revoke`, { reason: revokeReason.trim() }),
    {
      invalidate,
      success: () => 'Licence revoked. The tenant’s devices lose access at their next check.',
    },
  );
  const revokeDevice = useAction(
    (deviceId: string) => api.post(`/api/owner/licences/${licenceId}/devices/${deviceId}/revoke`),
    { invalidate, success: () => 'Device removed from the licence.' },
  );

  if (licence.isPending)
    return (
      <Card title="Licence">
        <Spinner />
      </Card>
    );
  if (licence.isError)
    return (
      <Card title="Licence">
        <Alert tone="danger">{errorMessage(licence.error)}</Alert>
      </Card>
    );
  const l = licence.data;
  const activeDevices = l.devices.filter((d) => !d.revoked_at);
  const days = daysUntil(l.ends_at);

  return (
    <>
      <Card
        title="Licence"
        actions={
          <Badge tone={licenceTone(l.state)}>
            {l.kind} · {l.state.replace('_', ' ')}
          </Badge>
        }
      >
        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <Row label="Started">{formatDate(l.starts_at)}</Row>
          <Row label="Ends">
            {formatDate(l.ends_at)}{' '}
            <span className="text-fg-muted">
              ({days >= 0 ? `in ${days} days` : `${-days} days ago`}; then {l.grace_days} days’
              grace)
            </span>
          </Row>
          <Row label="Seats">{l.seat_cap}</Row>
          <Row label="Devices">
            {activeDevices.length} of {l.max_devices}
          </Row>
          <Row label="Key">
            {revealed ? (
              <span className="font-mono" data-testid="revealed-key">
                {revealed}
              </span>
            ) : (
              <span className="font-mono text-fg-muted">AERO-•••••-•••••-•••••-•••••</span>
            )}
          </Row>
        </dl>

        {canWrite && l.state !== 'revoked' && (
          <div className="mt-5 space-y-4">
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button type="button" busy={resend.busy} onClick={() => void resend.run()}>
                Email the key again
              </Button>
              {!revealed && (
                <ConfirmButton
                  label="Show key"
                  confirmLabel="Show it (recorded in the audit log)"
                  busy={reveal.busy}
                  onConfirm={() => void reveal.run().then((r) => r && setRevealed(r.licenceKey))}
                />
              )}
            </div>
            {resend.done && <Alert tone="success">{resend.done}</Alert>}
            {(resend.error ?? reveal.error) && (
              <Alert tone="danger">{resend.error ?? reveal.error}</Alert>
            )}
            {l.kind === 'trial' && <TrialEnd licence={l} />}
            <div className="space-y-3 border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-danger">Revoke licence</h3>
              <p className="text-xs text-fg-muted">
                Every device loses access. There is no undo; the tenant would need a new licence.
              </p>
              <Field label="Reason (shown to the tenant)">
                <Input
                  name="revokeReason"
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  maxLength={500}
                />
              </Field>
              <ConfirmButton
                label="Revoke licence"
                confirmLabel="Click again to revoke"
                busy={revoke.busy}
                disabled={revokeReason.trim().length < 3}
                onConfirm={() => void revoke.run()}
              />
              {revoke.error && <Alert tone="danger">{revoke.error}</Alert>}
            </div>
          </div>
        )}
        {revoke.done && (
          <div className="mt-4">
            <Alert tone="success">{revoke.done}</Alert>
          </div>
        )}
      </Card>

      <Card title="Devices">
        {revokeDevice.done && (
          <div className="mb-3">
            <Alert tone="success">{revokeDevice.done}</Alert>
          </div>
        )}
        {revokeDevice.error && (
          <div className="mb-3">
            <Alert tone="danger">{revokeDevice.error}</Alert>
          </div>
        )}
        {l.devices.length === 0 ? (
          <p className="text-sm text-fg-muted">The key has not been entered on any device yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Label</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {l.devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.platform}</td>
                  <td className="max-w-[16rem] truncate text-fg-muted" title={d.label ?? ''}>
                    {d.label ?? '-'}
                  </td>
                  <td className="whitespace-nowrap text-fg-muted">{formatDate(d.first_seen_at)}</td>
                  <td className="whitespace-nowrap text-fg-muted">
                    {formatDateTime(d.last_seen_at)}
                  </td>
                  <td className="text-right">
                    {d.revoked_at ? (
                      <Badge>removed</Badge>
                    ) : (
                      canWrite && (
                        <ConfirmButton
                          label="Remove"
                          confirmLabel="Confirm"
                          onConfirm={() => void revokeDevice.run(d.id)}
                        />
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Licence history">
        <ol className="space-y-2 text-sm">
          {[...l.events].reverse().map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-3">
              <span className="w-40 shrink-0 text-fg-muted">{formatDateTime(e.created_at)}</span>
              <span className="font-medium">{e.kind.replace('_', ' ')}</span>
              <span className="text-fg-subtle">
                {e.actor.startsWith('operator:') ? 'owner console' : e.actor}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

function DatabaseCard({ tenantId }: { tenantId: string }) {
  const { canWrite } = useSession();
  const db = useQuery({
    queryKey: ['database', tenantId],
    queryFn: () =>
      api.get<DatabaseStatus>(`/api/owner/tenants/${tenantId}/database`).catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'tenant_db_not_found') return null;
        throw err;
      }),
    refetchInterval: (q) => (IN_PROGRESS.includes(q.state.data?.status ?? '') ? 3000 : false),
  });
  const invalidate = [['database', tenantId], ['tenant'], ['tenants'], ['overview']];
  const link = useAction(
    () =>
      api.post<{ url: string; expiresAt: string }>(
        `/api/owner/tenants/${tenantId}/onboarding-link`,
      ),
    {
      invalidate,
      success: (r) => `Link emailed to the tenant admin. It expires on ${formatDate(r.expiresAt)}.`,
    },
  );
  const local = useAction(
    () => api.post(`/api/owner/tenants/${tenantId}/provision`, { provider: 'local_postgres' }),
    { invalidate },
  );

  return (
    <Card
      title="Database"
      actions={
        db.data ? (
          <Badge tone={dbTone(db.data.status)}>{db.data.status.replace('_', ' ')}</Badge>
        ) : undefined
      }
    >
      {db.isPending ? (
        <Spinner />
      ) : db.isError ? (
        <Alert tone="danger">{errorMessage(db.error)}</Alert>
      ) : db.data ? (
        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
          <Row label="Provider">
            {db.data.provider === 'local_postgres' ? 'Local test database' : db.data.provider}
          </Row>
          <Row label="Schema version">{db.data.schemaVersion ?? '-'}</Row>
          {db.data.lastError && (
            <Row label="Last error">
              <span className="font-mono text-xs text-danger">{db.data.lastError}</span>
            </Row>
          )}
          {db.data.status === 'awaiting_consent' && (
            <Row label="Waiting for">
              The tenant to open the link and connect their Supabase account.
            </Row>
          )}
        </dl>
      ) : (
        <p className="text-sm text-fg-muted">
          Not started. The tenant connects their own Supabase account through an emailed link.
        </p>
      )}
      {canWrite && (!db.data || db.data.status === 'awaiting_consent') && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button type="button" busy={link.busy} onClick={() => void link.run()}>
            {db.data ? 'Email a new Supabase link' : 'Email Supabase connect link'}
          </Button>
          {!db.data && (
            <Button
              type="button"
              variant="secondary"
              busy={local.busy}
              onClick={() => void local.run()}
              title="Testing only: a database on this server's Postgres"
            >
              Use a local test database
            </Button>
          )}
        </div>
      )}
      {link.done && (
        <div className="mt-3">
          <Alert tone="success">{link.done}</Alert>
        </div>
      )}
      {(link.error ?? local.error) && (
        <div className="mt-3">
          <Alert tone="danger">{link.error ?? local.error}</Alert>
        </div>
      )}
    </Card>
  );
}

export function TenantDetailScreen({ tenantId }: { tenantId: string }) {
  const tenant = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => api.get<TenantDetail>(`/api/owner/tenants/${tenantId}`),
  });
  return (
    <div className="space-y-6">
      <Link
        to="/tenants"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tenants
      </Link>
      {tenant.isPending ? (
        <Spinner />
      ) : tenant.isError ? (
        <Alert tone="danger">{errorMessage(tenant.error)}</Alert>
      ) : (
        <>
          <PageHeader title={tenant.data.name} />
          <Card>
            <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
              <Row label="Admin email">{tenant.data.ownerEmail}</Row>
              <Row label="Created">{formatDate(tenant.data.createdAt)}</Row>
              <Row label="Tenant ID">
                <span className="font-mono text-xs">{tenant.data.id}</span>
              </Row>
            </dl>
          </Card>
          <div className="grid gap-6 xl:grid-cols-2">
            <div className="space-y-6">
              {tenant.data.licence ? (
                <LicenceCard
                  licenceId={tenant.data.licence.id}
                  ownerEmail={tenant.data.ownerEmail}
                />
              ) : (
                <Card title="Licence">
                  <p className="text-sm text-fg-muted">No licence.</p>
                </Card>
              )}
            </div>
            <div className="space-y-6">
              <DatabaseCard tenantId={tenantId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
