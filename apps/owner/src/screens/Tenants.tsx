import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner, toast } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { api, type TenantSummary } from '../api';
import { dbTone, errorMessage, formatDate, licenceTone } from '../format';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { PageHeader, Table } from './Shell';

function NewTrial({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const create = useAction(
    () =>
      api.post<{ tenantId: string }>('/api/owner/tenants', {
        email: email.trim(),
        tenantName: name.trim(),
      }),
    { invalidate: [['tenants'], ['overview']] },
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await create.run();
    if (r) toast.success(`Trial for ${name.trim()} created`);
    if (r) await navigate({ to: '/tenants/$tenantId', params: { tenantId: r.tenantId } });
  };
  return (
    <Card title="New trial">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 md:grid-cols-2">
        <Field
          label="Admin email"
          hint="Gets the licence key and a link to set the admin password."
        >
          <Input
            name="adminEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Company name">
          <Input
            name="tenantName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            required
          />
        </Field>
        <div className="flex items-center gap-2 md:col-span-2">
          <Button type="submit" busy={create.busy}>
            Create trial and email key
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {create.error && (
          <div className="md:col-span-2">
            <Alert tone="danger">{create.error}</Alert>
          </div>
        )}
      </form>
    </Card>
  );
}

export function TenantsScreen() {
  const { canWrite } = useSession();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const tenants = useQuery({
    queryKey: ['tenants', q],
    queryFn: () =>
      api.get<TenantSummary[]>(`/api/owner/tenants${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        actions={
          canWrite &&
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New trial
            </Button>
          )
        }
      />
      {creating && <NewTrial onClose={() => setCreating(false)} />}
      <Card>
        <div className="relative mb-4 max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search tenants"
            placeholder="Search by company or admin email"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tenants.isPending ? (
          <Spinner />
        ) : tenants.isError ? (
          <Alert tone="danger">{errorMessage(tenants.error)}</Alert>
        ) : tenants.data.length === 0 ? (
          <EmptyState title={q ? 'No tenant matches that search.' : 'No tenants yet'}>
            {q
              ? 'Search by part of the company name or the admin email.'
              : 'Start one with New trial: its admin gets a licence key and a link to set a password.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Admin email</th>
                <th>Licence</th>
                <th>Ends</th>
                <th>Devices</th>
                <th>Database</th>
              </tr>
            </thead>
            <tbody>
              {tenants.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      to="/tenants/$tenantId"
                      params={{ tenantId: t.id }}
                      className="font-medium text-accent hover:underline"
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td className="text-fg-muted">{t.ownerEmail}</td>
                  <td>
                    {t.licence ? (
                      <Badge tone={licenceTone(t.licence.state)}>
                        {t.licence.kind} · {t.licence.state.replace('_', ' ')}
                      </Badge>
                    ) : (
                      <Badge>none</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-fg-muted">
                    {t.licence ? formatDate(t.licence.endsAt) : '-'}
                  </td>
                  <td className="tabular-nums text-fg-muted">
                    {t.licence ? `${t.licence.activeDevices}` : '-'}
                  </td>
                  <td>
                    <Badge tone={dbTone(t.database?.status)}>
                      {t.database?.status.replace('_', ' ') ?? 'not started'}
                    </Badge>
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
