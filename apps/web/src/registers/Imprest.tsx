// Site imprest (docs/wave7-plan.md step 7d.6): petty-cash floats held by the project's team. Accounts pays advances in
// and takes back what is left; the holder enters what they spend; accounts settles the spends into the books.
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
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError, formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';

interface List {
  imprests: {
    id: string;
    number: string;
    purpose: string;
    floatLimit: string;
    status: 'open' | 'closed';
    custodian: string;
    advanced: string;
    spent: string;
    unsettled: string;
    balance: string;
  }[];
  team: { id: string; name: string }[];
  mayPost: boolean;
}
interface Ledger {
  id: string;
  code: string;
  name: string;
}
interface Imprest {
  id: string;
  number: string;
  purpose: string;
  floatLimit: string;
  status: 'open' | 'closed';
  projectId: string;
  custodian: string;
  company: string;
  totals: { advanced: string; spent: string; unsettled: string; returned: string; balance: string };
  entries: {
    id: string;
    kind: 'advance' | 'expense' | 'return';
    date: string;
    amount: string;
    account: string;
    description: string;
    reference: string;
    voucher: string | null;
    settled: boolean;
  }[];
  moneyLedgers: Ledger[];
  expenseLedgers: Ledger[];
  mayPost: boolean;
  maySpend: boolean;
}
const today = () => new Date().toISOString().slice(0, 10);
const KIND = { advance: 'Advance', expense: 'Spent', return: 'Taken back' } as const;

export function ImprestScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['imprests', projectId],
    queryFn: () => api.request<List>(`/api/tenant/projects/${projectId}/imprests`),
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Site imprest"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          list.data?.mayPost && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Open an imprest
            </Button>
          ) : null
        }
      />
      {adding && list.data ? (
        <NewImprest
          projectId={projectId}
          team={list.data.team}
          onDone={(id) => {
            setAdding(false);
            setOpen(id);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {open ? <ImprestCard id={open} /> : null}
      <Card title="Floats">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.imprests.length === 0 ? (
          <p className="text-sm text-fg-muted">No imprest on this project.</p>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Imprest</th>
                <th>Held by</th>
                <th className="text-right">Advanced</th>
                <th className="text-right">Spent</th>
                <th className="text-right">To settle</th>
                <th className="text-right">In hand</th>
              </tr>
            </thead>
            <tbody aria-label="Imprests">
              {list.data.imprests.map((i) => (
                <tr key={i.id}>
                  <td>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpen(i.id)}
                    >
                      <span className="font-mono text-xs">{i.number}</span> {i.purpose}
                    </button>
                    {i.status === 'closed' ? (
                      <span className="ml-1">
                        <Badge>closed</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td>{i.custodian}</td>
                  <td className="text-right">{formatInr(i.advanced)}</td>
                  <td className="text-right">{formatInr(i.spent)}</td>
                  <td className="text-right">{formatInr(i.unsettled)}</td>
                  <td className="text-right font-medium">{formatInr(i.balance)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function NewImprest({
  projectId,
  team,
  onDone,
  onCancel,
}: {
  projectId: string;
  team: List['team'];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({ custodianId: team[0]?.id ?? '', purpose: '', floatLimit: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Open an imprest">
      <form
        aria-label="Open an imprest"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request<Imprest>(`/api/tenant/projects/${projectId}/imprests`, {
              method: 'POST',
              body: { ...f, floatLimit: f.floatLimit || '0' },
            })
            .then((i) => {
              void qc.invalidateQueries({ queryKey: ['imprests', projectId] });
              onDone(i.id);
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Held by">
            <Select
              value={f.custodianId}
              onChange={(e) => setF({ ...f, custodianId: e.target.value })}
            >
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For">
            <Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />
          </Field>
          <Field label="Float (₹, blank for no limit)">
            <Input
              inputMode="decimal"
              value={f.floatLimit}
              onChange={(e) => setF({ ...f, floatLimit: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit">Open it</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}

type Move = 'advances' | 'expenses' | 'take-back';

export function ImprestCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const key = ['imprest', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<Imprest>(`/api/tenant/imprests/${id}`),
  });
  const [move, setMove] = useState<Move | null>(null);
  const [f, setF] = useState({
    date: today(),
    amount: '',
    accountId: '',
    description: '',
    reference: '',
    close: false,
  });
  const [error, setError] = useState<string | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const x = q.data;
  const send = async (path: Move | 'settle', body: object) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Imprest>(`/api/tenant/imprests/${id}/${path}`, { method: 'POST', body }),
      );
      setMove(null);
      setF({ ...f, amount: '', description: '', reference: '', close: false });
      void qc.invalidateQueries({ queryKey: ['imprests', x.projectId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const start = (m: Move) => {
    setMove(m);
    const ledgers = m === 'expenses' ? x.expenseLedgers : x.moneyLedgers;
    setF({
      ...f,
      accountId: ledgers[0]?.id ?? '',
      amount: m === 'take-back' ? x.totals.balance : '',
      close: m === 'take-back',
    });
  };
  const open = x.status === 'open';
  return (
    <Card title={`${x.number} · ${x.custodian}`}>
      <p className="mb-2 text-sm text-fg-muted" aria-label="Imprest totals">
        {x.company} · advanced {formatInr(x.totals.advanced)} · spent {formatInr(x.totals.spent)}
        {Number(x.totals.unsettled) ? ` (${formatInr(x.totals.unsettled)} to settle)` : ''} · in
        hand {formatInr(x.totals.balance)}
        {Number(x.floatLimit) ? ` of a float of ${formatInr(x.floatLimit)}` : ''} ·{' '}
        <Badge tone={open ? 'warning' : 'success'}>{x.status}</Badge>
      </p>
      {open ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {x.mayPost ? (
            <Button variant="secondary" onClick={() => start('advances')}>
              Pay an advance
            </Button>
          ) : null}
          {x.maySpend ? (
            <Button variant="secondary" onClick={() => start('expenses')}>
              Enter a spend
            </Button>
          ) : null}
          {x.mayPost && Number(x.totals.unsettled) ? (
            <Button variant="secondary" onClick={() => void send('settle', { date: today() })}>
              Settle the spends
            </Button>
          ) : null}
          {x.mayPost ? (
            <Button variant="ghost" onClick={() => start('take-back')}>
              Take back and close
            </Button>
          ) : null}
        </div>
      ) : null}
      {move ? (
        <form
          aria-label={move === 'advances' ? 'Advance' : move === 'expenses' ? 'Spend' : 'Take back'}
          className="mb-3 grid gap-3 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void send(move, { ...f, amount: f.amount || '0' });
          }}
        >
          <Field label="On">
            <Input
              type="date"
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value })}
            />
          </Field>
          <Field label="Amount (₹)">
            <Input
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
              required={move !== 'take-back'}
            />
          </Field>
          <Field
            label={move === 'expenses' ? 'Expense' : move === 'advances' ? 'Paid from' : 'Into'}
          >
            <Select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
              {(move === 'expenses' ? x.expenseLedgers : x.moneyLedgers).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={move === 'expenses' ? 'What for' : 'Note'}>
            <Input
              value={f.description}
              onChange={(e) => setF({ ...f, description: e.target.value })}
              required={move === 'expenses'}
            />
          </Field>
          <Field label="Bill or reference">
            <Input
              value={f.reference}
              onChange={(e) => setF({ ...f, reference: e.target.value })}
            />
          </Field>
          <div className="flex gap-2 md:col-span-5">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={() => setMove(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {x.entries.length ? (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>On</th>
              <th>What</th>
              <th>Ledger</th>
              <th className="text-right">Amount</th>
              <th>Voucher</th>
            </tr>
          </thead>
          <tbody aria-label="Imprest entries">
            {x.entries.map((e) => (
              <tr key={e.id}>
                <td>{shortDate(e.date)}</td>
                <td>
                  {KIND[e.kind]}
                  {e.description ? ` · ${e.description}` : ''}
                  {e.reference ? (
                    <span className="text-xs text-fg-muted"> ({e.reference})</span>
                  ) : null}
                </td>
                <td>{e.account}</td>
                <td className="text-right">{formatInr(e.amount)}</td>
                <td className="font-mono text-xs">
                  {e.voucher ?? <Badge tone="warning">to settle</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
