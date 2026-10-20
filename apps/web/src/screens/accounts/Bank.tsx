// Bank reconciliation (docs/wave3-plan.md step 7): a bank ledger's statements imported (by its saved column mapping,
// or OFX or MT940); each statement line matched to the ledger's vouchers (suggested, or picked); a line only the bank
// knows made a voucher in one click; the reconciliation statement as at a date.
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
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { ledgerOptions, today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { Books } from './Vouchers';

interface BookLine {
  voucherId: string;
  position: number;
  number: string;
  date: string;
  narration: string;
  reference: string;
  amount: string;
}
interface Statement {
  lines: {
    id: string;
    date: string;
    narration: string;
    reference: string;
    amount: string;
    balance: string | null;
    match: { id: string; vouchers: { voucherId: string; number: string }[] } | null;
    suggestions: (BookLine & { byReference: boolean })[];
  }[];
  book: BookLine[];
  mayPost: boolean;
}
interface Mapping {
  date: string;
  narration: string;
  reference: string | null;
  withdrawal: string | null;
  deposit: string | null;
  amount: string | null;
  balance: string | null;
  dateFormat: string;
}
interface Reconciliation {
  books: string;
  notPresented: { total: string; lines: BookLine[] };
  notCredited: { total: string; lines: BookLine[] };
  bankOnly: {
    total: string;
    lines: { id: string; date: string; narration: string; amount: string }[];
  };
  perBank: string;
  statement: { balance: string; date: string } | null;
  difference: string | null;
}
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const signed = (v: string) => (Number(v) < 0 ? `−${rupees(v.replace('-', ''))}` : rupees(v));

export function BankScreen() {
  const chart = useChart();
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  const [chosen, setChosen] = useState('');
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const accountId = chosen || banks[0]?.id || '';
  return (
    <Books title="Bank">
      {(entityId) =>
        chart.isPending ? (
          <Spinner />
        ) : !accountId ? (
          <Alert tone="info">Add a bank ledger in the chart of accounts first.</Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Bank ledger">
                <Select value={accountId} onChange={(e) => setChosen(e.target.value)}>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="From">
                <Input
                  type="date"
                  className="w-40"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  className="w-40"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </div>
            <Import key={`i-${accountId}`} accountId={accountId} />
            <StatementCard
              key={`s-${accountId}`}
              entityId={entityId}
              accountId={accountId}
              from={from}
              to={to}
            />
            <ReconciliationCard
              key={`r-${accountId}`}
              entityId={entityId}
              accountId={accountId}
              asOf={to}
            />
          </>
        )
      }
    </Books>
  );
}

function Import({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const m = useQuery({
    queryKey: ['bank-mapping', accountId],
    queryFn: () =>
      api.request<{ mapping: Mapping | null }>(`/api/tenant/accounts/bank/${accountId}/mapping`),
  });
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Mapping | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (m.isPending) return <Spinner />;
  const form: Mapping = f ??
    m.data?.mapping ?? {
      date: 'Txn Date',
      narration: 'Description',
      reference: 'Ref No',
      withdrawal: 'Debit',
      deposit: 'Credit',
      amount: null,
      balance: 'Balance',
      dateFormat: 'DD/MM/YYYY',
    };
  const set = (k: keyof Mapping) => (e: { target: { value: string } }) =>
    setF({ ...form, [k]: e.target.value || null });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['bank-mapping', accountId],
        await api.request(`/api/tenant/accounts/bank/${accountId}/mapping`, {
          method: 'PUT',
          body: form,
        }),
      );
      setEditing(false);
      toast.success('Column mapping saved');
    } catch (err) {
      setError(describeError(err));
    }
  };
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.upload<{ imported: number; skipped: number }>(
        `/api/tenant/accounts/bank/${accountId}/statements`,
        file,
      );
      setNote(`${r.imported} lines imported${r.skipped ? `, ${r.skipped} seen before` : ''}.`);
      toast.success(`${r.imported} lines imported`);
      void qc.invalidateQueries({ queryKey: ['bank-statement'] });
      void qc.invalidateQueries({ queryKey: ['bank-reconciliation'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card
      title="Statements"
      actions={
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => setEditing(!editing)}>
            Column mapping
          </Button>
          <input
            ref={input}
            type="file"
            accept=".csv,.xlsx,.ofx,.qfx,.sta,.mt940,.txt"
            aria-label="Statement file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          <Button
            type="button"
            variant="secondary"
            busy={busy}
            onClick={() => input.current?.click()}
          >
            <Upload className="size-4" aria-hidden /> Import a statement
          </Button>
        </div>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {note && (
        <p className="text-sm" aria-label="Import result">
          {note}
        </p>
      )}
      <p className="text-sm text-fg-muted">
        CSV or Excel by this bank's column mapping{m.data?.mapping ? '' : ' (not set yet)'}; OFX and
        MT940 as they come.
      </p>
      {editing && (
        <form
          aria-label="Column mapping"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => void save(e)}
        >
          <Field label="Date column">
            <Input value={form.date} onChange={set('date')} required />
          </Field>
          <Field label="Narration column">
            <Input value={form.narration} onChange={set('narration')} required />
          </Field>
          <Field label="Reference column">
            <Input value={form.reference ?? ''} onChange={set('reference')} />
          </Field>
          <Field label="Date format">
            <Select value={form.dateFormat} onChange={set('dateFormat')}>
              {['DD/MM/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
          <Field label="Withdrawal column">
            <Input value={form.withdrawal ?? ''} onChange={set('withdrawal')} />
          </Field>
          <Field label="Deposit column">
            <Input value={form.deposit ?? ''} onChange={set('deposit')} />
          </Field>
          <Field label="Or one amount column" hint="Withdrawals negative">
            <Input value={form.amount ?? ''} onChange={set('amount')} />
          </Field>
          <Field label="Balance column">
            <Input value={form.balance ?? ''} onChange={set('balance')} />
          </Field>
          <div>
            <Button type="submit">Save the mapping</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function StatementCard({
  entityId,
  accountId,
  from,
  to,
}: {
  entityId: string;
  accountId: string;
  from: string;
  to: string;
}) {
  const qc = useQueryClient();
  const key = ['bank-statement', accountId, entityId, from, to];
  const s = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Statement>(
        `/api/tenant/accounts/bank/${accountId}/statement?entityId=${entityId}&from=${from}&to=${to}`,
      ),
  });
  const chart = useChart();
  const [open, setOpen] = useState<{ id: string; mode: 'pick' | 'post' } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [post, setPost] = useState({ accountId: '', narration: '' });
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const done = () => {
    setOpen(null);
    setPicked([]);
    setPost({ accountId: '', narration: '' });
    void qc.invalidateQueries({ queryKey: ['bank-statement'] });
    void qc.invalidateQueries({ queryKey: ['bank-reconciliation'] });
  };
  const call = async (path: string, body: object, said: string) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      toast.success(said);
      done();
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (s.isPending) return <Spinner />;
  if (s.isError) return <Alert tone="danger">{describeError(s.error)}</Alert>;
  const keyOf = (b: BookLine) => `${b.voucherId}:${b.position}`;
  return (
    <Card title="Statement lines">
      {error && <Alert tone="danger">{error}</Alert>}
      {s.data.lines.length === 0 ? (
        <EmptyState title="No statement lines in these dates.">
          Import the bank&apos;s statement above, or widen the dates.
        </EmptyState>
      ) : (
        <Table minWidth="56rem">
          <thead>
            <tr>
              <th>Date</th>
              <th>Narration</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Balance</th>
              <th>Matched to</th>
            </tr>
          </thead>
          <tbody aria-label="Statement lines">
            {s.data.lines.map((l) => (
              <tr key={l.id} className="align-top">
                <td>{shortDate(l.date)}</td>
                <td>
                  {l.narration}
                  {l.reference && (
                    <div className="font-mono text-xs text-fg-muted">{l.reference}</div>
                  )}
                </td>
                <td
                  className={cx('text-right tabular-nums', Number(l.amount) > 0 && 'text-success')}
                >
                  {signed(l.amount)}
                </td>
                <td className="text-right tabular-nums">{l.balance ? signed(l.balance) : ''}</td>
                <td>
                  {l.match ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="success">
                        {l.match.vouchers.map((v) => v.number).join(', ')}
                      </Badge>
                      {s.data.mayPost && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            const reason = window.prompt('Why is the match undone?');
                            if (reason && reason.trim().length >= 3)
                              void call(
                                `/api/tenant/accounts/bank-matches/${l.match!.id}/undo`,
                                { reason: reason.trim() },
                                'Match undone',
                              );
                          }}
                        >
                          Undo
                        </Button>
                      )}
                    </span>
                  ) : s.data.mayPost ? (
                    <div className="space-y-2" role="group" aria-label={`Match ${l.narration}`}>
                      {l.suggestions.map((x) => (
                        <Button
                          key={keyOf(x)}
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            void call(
                              `/api/tenant/accounts/bank-lines/${l.id}/match`,
                              {
                                entityId,
                                lines: [{ voucherId: x.voucherId, position: x.position }],
                              },
                              `Matched to ${x.number}`,
                            )
                          }
                        >
                          Match {x.number} of {shortDate(x.date)}
                          {x.byReference ? ' (reference)' : ''}
                        </Button>
                      ))}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setOpen({ id: l.id, mode: 'pick' })}
                        >
                          Pick vouchers
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setOpen({ id: l.id, mode: 'post' })}
                        >
                          Make a voucher
                        </Button>
                      </div>
                      {open?.id === l.id && open.mode === 'pick' && (
                        <div className="space-y-1 rounded-md border border-line p-2">
                          {s.data.book
                            .filter(
                              (b) => Math.sign(Number(b.amount)) === Math.sign(Number(l.amount)),
                            )
                            .map((b) => (
                              <label key={keyOf(b)} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={picked.includes(keyOf(b))}
                                  onChange={(e) =>
                                    setPicked(
                                      e.target.checked
                                        ? [...picked, keyOf(b)]
                                        : picked.filter((k) => k !== keyOf(b)),
                                    )
                                  }
                                />
                                {b.number} {shortDate(b.date)} {b.reference} {signed(b.amount)}
                              </label>
                            ))}
                          <Button
                            type="button"
                            disabled={!picked.length}
                            onClick={() =>
                              void call(
                                `/api/tenant/accounts/bank-lines/${l.id}/match`,
                                {
                                  entityId,
                                  lines: picked.map((k) => ({
                                    voucherId: k.split(':')[0],
                                    position: Number(k.split(':')[1]),
                                  })),
                                },
                                'Statement line matched',
                              )
                            }
                          >
                            Match the picked
                          </Button>
                        </div>
                      )}
                      {open?.id === l.id && open.mode === 'post' && (
                        <form
                          aria-label="Make a voucher"
                          className="flex flex-wrap items-end gap-2 rounded-md border border-line p-2"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (
                              !(await confirm({
                                title: `Post a voucher for ${signed(l.amount)}?`,
                                body: 'A voucher is posted to the books against the chosen ledger and matched to this statement line.',
                                confirmLabel: 'Post and match',
                                tone: 'primary',
                              }))
                            )
                              return;
                            void call(
                              `/api/tenant/accounts/bank-lines/${l.id}/post`,
                              { entityId, ...post },
                              'Voucher posted and matched',
                            );
                          }}
                        >
                          <Field label="Ledger">
                            <Select
                              value={post.accountId}
                              onChange={(e) => setPost({ ...post, accountId: e.target.value })}
                              required
                            >
                              <option value="">Which ledger?</option>
                              {ledgerOptions(
                                (chart.data?.accounts ?? []).filter(
                                  (a) => a.id !== accountId && a.kind !== 'party',
                                ),
                              ).map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Narration">
                            <Input
                              value={post.narration}
                              onChange={(e) => setPost({ ...post, narration: e.target.value })}
                              required
                              minLength={2}
                            />
                          </Field>
                          <Button type="submit">Post and match</Button>
                        </form>
                      )}
                    </div>
                  ) : (
                    <Badge tone="warning">Not matched</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ReconciliationCard({
  entityId,
  accountId,
  asOf,
}: {
  entityId: string;
  accountId: string;
  asOf: string;
}) {
  const r = useQuery({
    queryKey: ['bank-reconciliation', accountId, entityId, asOf],
    queryFn: () =>
      api.request<Reconciliation>(
        `/api/tenant/accounts/bank/${accountId}/reconciliation?entityId=${entityId}&asOf=${asOf}`,
      ),
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const row = (label: string, v: string, strong = false) => (
    <tr className={cx(strong && 'font-semibold')}>
      <td>{label}</td>
      <td className="text-right tabular-nums">{signed(v)}</td>
    </tr>
  );
  return (
    <Card title={`Reconciliation as at ${shortDate(asOf)}`}>
      <Table minWidth="28rem">
        <tbody aria-label="Reconciliation">
          {row('Balance as per the books', d.books, true)}
          {row(
            `Add: cheques issued, not presented (${d.notPresented.lines.length})`,
            d.notPresented.total,
          )}
          {row(
            `Less: deposits not yet credited (${d.notCredited.lines.length})`,
            `-${d.notCredited.total}`,
          )}
          {row(`On the statement, not in the books (${d.bankOnly.lines.length})`, d.bankOnly.total)}
          {row('Balance as per the bank', d.perBank, true)}
          {d.statement &&
            row(`The statement's balance on ${shortDate(d.statement.date)}`, d.statement.balance)}
        </tbody>
      </Table>
      {d.difference !== null &&
        (Number(d.difference) === 0 ? (
          <p className="mt-3 text-sm text-success">The books and the statement agree.</p>
        ) : (
          <Alert tone="warning">Differs from the statement by {signed(d.difference)}.</Alert>
        ))}
      {d.notPresented.lines.length + d.notCredited.lines.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Open in the books">
          {[...d.notPresented.lines, ...d.notCredited.lines].map((l) => (
            <li key={`${l.voucherId}:${l.position}`}>
              {shortDate(l.date)} {l.number} {l.reference}: {signed(l.amount)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
