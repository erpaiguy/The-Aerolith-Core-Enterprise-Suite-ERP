// Settings › Integrations (docs/wave6-plan.md step 6), for admins: API keys for the public API and the Tally agent,
// webhooks with their recent deliveries, and how far Tally has caught up.
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
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';

const SCOPES: [string, string][] = [
  ['reports:read', 'Read the report views'],
  ['tally', 'Tally agent'],
];
const EVENTS: [string, string][] = [
  ['order.issued', 'Order issued'],
  ['receipt.posted', 'Goods received'],
  ['bill.certified', 'Bill certified'],
  ['portal.submission', 'Sent from a portal'],
];
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN') : '—');

interface Key {
  id: string;
  name: string;
  scopes: string[];
  last4: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface Hooks {
  hooks: { id: string; url: string; events: string[]; active: boolean; failed: number }[];
  deliveries: {
    id: string;
    webhookId: string;
    event: string;
    status: string;
    attempts: number;
    lastStatus: number | null;
    lastError: string | null;
    createdAt: string;
  }[];
}

export function IntegrationsScreen() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.request<Key[]>('/api/tenant/integrations/api-keys'),
  });
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.request<Hooks>('/api/tenant/integrations/webhooks'),
  });
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () =>
      api.request<{ companies: { id: string; name: string }[] }>('/api/tenant/companies'),
  });
  const [entityId, setEntityId] = useState('');
  const company = entityId || companies.data?.companies[0]?.id || '';
  const tally = useQuery({
    queryKey: ['tally-sync', company],
    queryFn: () =>
      api.request<{
        exportOn: boolean;
        created: number;
        failed: number;
        waiting: number;
        lastSyncAt: string | null;
        failures: { number: string; response: string }[];
      }>(`/api/tenant/integrations/tally-sync?entityId=${company}`),
    enabled: Boolean(company),
    retry: false,
  });

  const [keyForm, setKeyForm] = useState({ name: '', scopes: ['reports:read'] });
  const [hookForm, setHookForm] = useState({ url: '', events: ['order.issued'] });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<void>, done: string) => {
    setError(null);
    try {
      await f();
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
      toast.success(done);
    } catch (err) {
      setError(describeError(err));
    }
  };
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        subtitle="Keys for the public API and the Tally agent, and webhooks that tell your other systems when something happens."
      />
      {secret && (
        <Alert tone="success">
          {secret.label} It is shown only now; keep it somewhere safe:
          <Input
            readOnly
            aria-label="Secret"
            value={secret.value}
            className="mt-2 font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <Card title="API keys">
        <form
          aria-label="New API key"
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.request<{ key: string }>('/api/tenant/integrations/api-keys', {
                method: 'POST',
                body: keyForm,
              });
              setSecret({ label: `The key "${keyForm.name}".`, value: r.key });
              setKeyForm({ ...keyForm, name: '' });
            }, `Key ${keyForm.name} made`);
          }}
        >
          <Field label="Key name">
            <Input
              value={keyForm.name}
              onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
              required
            />
          </Field>
          {SCOPES.map(([s, label]) => (
            <label key={s} className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={keyForm.scopes.includes(s)}
                onChange={() => setKeyForm({ ...keyForm, scopes: toggle(keyForm.scopes, s) })}
              />
              {label}
            </label>
          ))}
          <Button type="submit" disabled={!keyForm.scopes.length}>
            Make key
          </Button>
        </form>
        <p className="mb-3 text-xs text-fg-muted">
          A key acts as you: it sees what you see. Documentation:{' '}
          <a className="underline" href="/api/v1/openapi.json">
            /api/v1/openapi.json
          </a>
          .
        </p>
        {!keys.data ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
                <th>Made</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody aria-label="API keys">
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>
                    {k.name} <span className="font-mono text-xs text-fg-muted">…{k.last4}</span>
                  </td>
                  <td>{k.scopes.join(', ')}</td>
                  <td>
                    {k.createdBy}, {when(k.createdAt)}
                  </td>
                  <td>{when(k.lastUsedAt)}</td>
                  <td>
                    {k.revokedAt ? (
                      <Badge>revoked</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: `Revoke the key ${k.name}?`,
                              body: 'Anything using it is refused from now on. A revoked key cannot be brought back; make a new one instead.',
                              confirmLabel: 'Revoke the key',
                              tone: 'danger',
                            }))
                          )
                            return;
                          await run(async () => {
                            await api.request(`/api/tenant/integrations/api-keys/${k.id}/revoke`, {
                              method: 'POST',
                            });
                          }, `Key ${k.name} revoked`);
                        }}
                      >
                        Revoke {k.name}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Webhooks">
        <form
          aria-label="New webhook"
          className="mb-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.request<{ secret: string }>('/api/tenant/integrations/webhooks', {
                method: 'POST',
                body: hookForm,
              });
              setSecret({ label: `The signing secret for ${hookForm.url}.`, value: r.secret });
              setHookForm({ ...hookForm, url: '' });
            }, 'Webhook added');
          }}
        >
          <Field label="Address (https)">
            <Input
              type="url"
              value={hookForm.url}
              onChange={(e) => setHookForm({ ...hookForm, url: e.target.value })}
              required
            />
          </Field>
          <div className="flex flex-wrap gap-4">
            {EVENTS.map(([ev, label]) => (
              <label key={ev} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={hookForm.events.includes(ev)}
                  onChange={() => setHookForm({ ...hookForm, events: toggle(hookForm.events, ev) })}
                />
                {label}
              </label>
            ))}
          </div>
          <Button type="submit" disabled={!hookForm.events.length}>
            Add webhook
          </Button>
        </form>
        {hooks.data && (
          <div className="space-y-4">
            <ul className="space-y-2 text-sm">
              {hooks.data.hooks.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{h.url}</span>
                  <span className="text-fg-muted">{h.events.join(', ')}</span>
                  {!h.active && <Badge>off</Badge>}
                  {h.failed > 0 && <Badge tone="danger">{h.failed} failed</Badge>}
                  {h.active && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void run(async () => {
                            await api.request(`/api/tenant/integrations/webhooks/${h.id}/test`, {
                              method: 'POST',
                            });
                          }, 'Test sent')
                        }
                      >
                        Send a test
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: `Turn off the webhook to ${h.url}?`,
                              body: 'Nothing more is sent to this address. To start again, add the webhook anew.',
                              confirmLabel: 'Turn the webhook off',
                              tone: 'danger',
                            }))
                          )
                            return;
                          await run(async () => {
                            await api.request(`/api/tenant/integrations/webhooks/${h.id}/disable`, {
                              method: 'POST',
                            });
                          }, 'Webhook turned off');
                        }}
                      >
                        Turn off
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {hooks.data.deliveries.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>When</th>
                    <th>Status</th>
                    <th>Tries</th>
                    <th>Last answer</th>
                  </tr>
                </thead>
                <tbody>
                  {hooks.data.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>{d.event}</td>
                      <td>{when(d.createdAt)}</td>
                      <td>
                        <Badge
                          tone={
                            d.status === 'delivered'
                              ? 'success'
                              : d.status === 'failed'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {d.status}
                        </Badge>
                      </td>
                      <td>{d.attempts}</td>
                      <td className="text-xs">{d.lastError ?? d.lastStatus ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </Card>

      <Card title="Tally agent">
        <p className="mb-3 text-sm text-fg-muted">
          The agent runs on a PC beside Tally Prime and sends vouchers into it (tools/tally-agent in
          the release). Give it a key with the Tally scope.
        </p>
        {(companies.data?.companies.length ?? 0) > 1 && (
          <Field label="Company">
            <Select value={company} onChange={(e) => setEntityId(e.target.value)}>
              {companies.data!.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {tally.error ? (
          <p className="text-sm text-fg-muted">{describeError(tally.error)}</p>
        ) : tally.data && !tally.data.exportOn ? (
          <p className="text-sm text-fg-muted" data-testid="tally-off">
            The Tally export is off: the accounts mode is &ldquo;native&rdquo;. Turn it on under
            Accounts &rsaquo; Statements to use the agent.
          </p>
        ) : tally.data ? (
          <div className="space-y-2 text-sm">
            <p>
              In Tally {tally.data.created}, waiting {tally.data.waiting}, refused{' '}
              {tally.data.failed}. Last run {when(tally.data.lastSyncAt)}.
            </p>
            {tally.data.failures.length > 0 && (
              <ul className="space-y-1">
                {tally.data.failures.map((f) => (
                  <li key={f.number}>
                    <strong>{f.number}</strong>: {f.response}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
