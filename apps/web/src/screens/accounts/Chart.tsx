// The chart of accounts and the account map (docs/wave3-plan.md step 1). Everyone with the books sees them; the admin
// adds, renames, moves and closes accounts, and maps each role later steps post to.
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table, cx } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { KIND, ledgerOptions, useChart, type Account } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { Books } from './Vouchers';

type Form = {
  parentId: string;
  isGroup: boolean;
  code: string;
  name: string;
  kind: Account['kind'];
  needsProject: boolean;
  closed: boolean;
};

export function ChartScreen() {
  const qc = useQueryClient();
  const chart = useChart();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const accounts = useMemo(() => chart.data?.accounts ?? [], [chart.data]);
  const rows = useMemo(() => {
    const kids = new Map<string, Account[]>();
    for (const a of accounts) {
      const k = a.parentId ?? '';
      kids.set(k, [...(kids.get(k) ?? []), a]);
    }
    const out: (Account & { depth: number })[] = [];
    const walk = (p: string, depth: number) => {
      for (const a of kids.get(p) ?? []) {
        out.push({ ...a, depth });
        walk(a.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [accounts]);
  const groups = rows.filter((a) => a.isGroup);
  return (
    <Books
      title="Chart of accounts"
      subtitle="One chart for every company; balances are kept by company."
    >
      {(entityId) => {
        if (chart.isPending) return <Spinner />;
        if (chart.isError) return <Alert tone="danger">{describeError(chart.error)}</Alert>;
        const done = (data: { accounts: Account[]; mayEdit: boolean }) => {
          qc.setQueryData(['chart'], data);
          setEditing(null);
        };
        return (
          <>
            <Card
              title="Accounts"
              actions={
                chart.data.mayEdit &&
                editing !== 'new' && (
                  <Button type="button" variant="secondary" onClick={() => setEditing('new')}>
                    <Plus className="size-4" aria-hidden /> Add an account
                  </Button>
                )
              }
            >
              {editing === 'new' && (
                <AccountForm groups={groups} onCancel={() => setEditing(null)} onDone={done} />
              )}
              <Table minWidth="40rem">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Kind</th>
                    <th />
                  </tr>
                </thead>
                <tbody aria-label="Chart of accounts">
                  {rows.map((a) => (
                    <tr
                      key={a.id}
                      className={cx(a.isGroup && 'font-medium', a.closed && 'text-fg-muted')}
                    >
                      <td style={{ paddingLeft: `${0.75 + a.depth * 1.25}rem` }}>
                        {editing === a.id ? (
                          <AccountForm
                            account={a}
                            groups={groups.filter((g) => g.nature === a.nature && g.id !== a.id)}
                            onCancel={() => setEditing(null)}
                            onDone={done}
                          />
                        ) : (
                          <>
                            <span className="font-mono text-xs text-fg-muted">{a.code}</span>{' '}
                            {a.name} {a.needsProject && <Badge>Needs a project</Badge>}{' '}
                            {a.closed && <Badge>Closed</Badge>}
                          </>
                        )}
                      </td>
                      <td className="text-sm">{a.isGroup ? 'Group' : KIND[a.kind]}</td>
                      <td className="text-right">
                        {chart.data.mayEdit && a.parentId && editing !== a.id && (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setEditing(a.id)}
                            aria-label={`Edit ${a.name}`}
                          >
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <AccountMap entityId={entityId} accounts={accounts} />
          </>
        );
      }}
    </Books>
  );
}

function AccountForm({
  account,
  groups,
  onCancel,
  onDone,
}: {
  account?: Account;
  groups: Account[];
  onCancel: () => void;
  onDone: (data: { accounts: Account[]; mayEdit: boolean }) => void;
}) {
  const [f, setF] = useState<Form>({
    parentId: account?.parentId ?? groups[0]?.id ?? '',
    isGroup: account?.isGroup ?? false,
    code: account?.code ?? '',
    name: account?.name ?? '',
    kind: account?.kind ?? 'ordinary',
    needsProject: account?.needsProject ?? false,
    closed: account?.closed ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, kind: f.isGroup || f.kind === 'party' ? 'ordinary' : f.kind };
      onDone(
        await api.request(
          account ? `/api/tenant/accounts/chart/${account.id}` : '/api/tenant/accounts/chart',
          {
            method: 'POST',
            body: account ? { ...body, rowVersion: account.rowVersion } : body,
          },
        ),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="my-2 space-y-3 rounded-md border border-line p-3 font-normal"
      aria-label={account ? `Edit ${account.name}` : 'New account'}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_1fr]">
        <Field label="Under">
          <Select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code} {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Code">
          <Input
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            required
            maxLength={20}
          />
        </Field>
        <Field label="Name">
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            maxLength={120}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {!account && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.isGroup}
              onChange={(e) => setF({ ...f, isGroup: e.target.checked })}
            />
            A group (holds other accounts)
          </label>
        )}
        {!f.isGroup && f.kind !== 'party' && (
          <label className="flex items-center gap-2">
            Kind
            <Select
              aria-label="Kind"
              className="w-32"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value as Account['kind'] })}
            >
              {(['ordinary', 'bank', 'cash', 'tax'] as const).map((k) => (
                <option key={k} value={k}>
                  {KIND[k]}
                </option>
              ))}
            </Select>
          </label>
        )}
        {!f.isGroup && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.needsProject}
              onChange={(e) => setF({ ...f, needsProject: e.target.checked })}
            />
            Each line names a project
          </label>
        )}
        {account && !account.isGroup && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.closed}
              onChange={(e) => setF({ ...f, closed: e.target.checked })}
            />
            Closed (no new entries)
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          {account ? 'Save' : 'Add'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AccountMap({ entityId, accounts }: { entityId: string; accounts: Account[] }) {
  const qc = useQueryClient();
  const key = ['account-map', entityId];
  const map = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{
        roles: {
          role: string;
          label: string;
          account: { id: string; code: string; name: string } | null;
        }[];
        mayEdit: boolean;
      }>(`/api/tenant/accounts/map?entityId=${entityId}`),
  });
  const [error, setError] = useState<string | null>(null);
  const options = ledgerOptions(accounts.filter((a) => a.kind !== 'party'));
  if (map.isPending) return <Spinner />;
  if (map.isError) return <Alert tone="danger">{describeError(map.error)}</Alert>;
  const set = (role: string, accountId: string) => {
    setError(null);
    void api
      .request(`/api/tenant/accounts/map`, { method: 'POST', body: { entityId, role, accountId } })
      .then((d) => qc.setQueryData(key, d))
      .catch((err: unknown) => setError(describeError(err)));
  };
  return (
    <Card title="Account map">
      <p className="mb-3 text-sm text-fg-muted">
        Where bills, receipts, payments and stock post for this company. Change a role to post to
        another ledger.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th>Posts</th>
            <th>To</th>
          </tr>
        </thead>
        <tbody aria-label="Account map">
          {map.data.roles.map((r) => (
            <tr key={r.role}>
              <td className="text-sm">{r.label}</td>
              <td>
                {map.data.mayEdit ? (
                  <Select
                    aria-label={`Ledger for ${r.label}`}
                    value={r.account?.id ?? ''}
                    onChange={(e) => set(r.role, e.target.value)}
                  >
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-sm">
                    {r.account ? `${r.account.code} ${r.account.name}` : '-'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
