// Receivables (docs/wave3-plan.md step 3): what each client owes, aged; recording a client's payment against its
// certified bills, retention released and advances; one receipt, cancelled by reversing it.
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import type { Party } from '../../api/types';
import { ledgerOptions, today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from './Vouchers';
import { printLink } from '../../print/Letterhead';

interface Report {
  asOf: string;
  buckets: string[];
  clients: {
    party: { id: string; name: string };
    buckets: string[];
    outstanding: string;
    retentionHeld: string;
    advanceUnrecovered: string;
  }[];
  bills: {
    id: string;
    raNo: number;
    project: { id: string; number: string; name: string };
    party: { id: string; name: string };
    invoiceNo: string;
    invoiceDate: string;
    net: string;
    received: string;
    outstanding: string;
    ageDays: number;
    bucket: string;
  }[];
  totals: {
    buckets: string[];
    outstanding: string;
    retentionHeld: string;
    advanceUnrecovered: string;
  };
}

export function ReceivablesScreen() {
  const [asOf, setAsOf] = useState(today());
  const mayPost = usePermission('accounts.post');
  return (
    <Books
      title="Receivables"
      actions={
        mayPost && (
          <Link
            to="/accounts/client-receipts/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="size-4" aria-hidden /> Record a receipt
          </Link>
        )
      }
    >
      {(entityId) => (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="As at">
              <Input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="w-40"
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void api
                  .download(
                    `/api/tenant/accounts/receivables?entityId=${entityId}&asOf=${asOf}&format=xlsx`,
                  )
                  .then(({ blob, fileName }) => saveFile(blob, fileName))
              }
            >
              <FileSpreadsheet className="size-4" aria-hidden /> Excel
            </Button>
          </div>
          <Ageing entityId={entityId} asOf={asOf} />
          <Receipts entityId={entityId} />
        </>
      )}
    </Books>
  );
}

function Ageing({ entityId, asOf }: { entityId: string; asOf: string }) {
  const r = useQuery({
    queryKey: ['receivables', entityId, asOf],
    queryFn: () =>
      api.request<Report>(`/api/tenant/accounts/receivables?entityId=${entityId}&asOf=${asOf}`),
    placeholderData: keepPreviousData,
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  return (
    <>
      <Card title="By client">
        {d.clients.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is owed.</p>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Client</th>
                {d.buckets.map((b) => (
                  <th key={b} className="text-right">
                    {b} days
                  </th>
                ))}
                <th className="text-right">Outstanding</th>
                <th className="text-right">Retention held</th>
                <th className="text-right">Advance to recover</th>
              </tr>
            </thead>
            <tbody aria-label="Receivables by client">
              {d.clients.map((c) => (
                <tr key={c.party.id}>
                  <td>{c.party.name}</td>
                  {c.buckets.map((v, i) => (
                    <td key={i} className="text-right tabular-nums">
                      {Number(v) ? rupees(v) : ''}
                    </td>
                  ))}
                  <td className="text-right font-medium tabular-nums">{rupees(c.outstanding)}</td>
                  <td className="text-right tabular-nums">
                    {Number(c.retentionHeld) ? rupees(c.retentionHeld) : ''}
                  </td>
                  <td className="text-right tabular-nums">
                    {Number(c.advanceUnrecovered) ? rupees(c.advanceUnrecovered) : ''}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line font-semibold">
                <td>Total</td>
                {d.totals.buckets.map((v, i) => (
                  <td key={i} className="text-right tabular-nums">
                    {rupees(v)}
                  </td>
                ))}
                <td className="text-right tabular-nums">{rupees(d.totals.outstanding)}</td>
                <td className="text-right tabular-nums">{rupees(d.totals.retentionHeld)}</td>
                <td className="text-right tabular-nums">{rupees(d.totals.advanceUnrecovered)}</td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
      {d.bills.length > 0 && (
        <Card title="Bills outstanding">
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Client</th>
                <th>Bill</th>
                <th>Invoice</th>
                <th className="text-right">Net payable</th>
                <th className="text-right">Received</th>
                <th className="text-right">Outstanding</th>
                <th className="text-right">Days</th>
              </tr>
            </thead>
            <tbody aria-label="Bills outstanding">
              {d.bills.map((b) => (
                <tr key={b.id}>
                  <td className="text-sm">{b.party.name}</td>
                  <td>
                    <Link
                      to="/client-bills/$billId"
                      params={{ billId: b.id }}
                      className="text-accent hover:underline"
                    >
                      {b.project.number} RA {b.raNo}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap text-sm">
                    <span className="font-mono text-xs">{b.invoiceNo}</span>{' '}
                    {shortDate(b.invoiceDate)}
                  </td>
                  <td className="text-right tabular-nums">{rupees(b.net)}</td>
                  <td className="text-right tabular-nums">
                    {Number(b.received) ? rupees(b.received) : ''}
                  </td>
                  <td className="text-right font-medium tabular-nums">{rupees(b.outstanding)}</td>
                  <td className="text-right tabular-nums">
                    {b.ageDays} {b.ageDays > 90 && <Badge tone="danger">over 90</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function Receipts({ entityId }: { entityId: string }) {
  const list = useQuery({
    queryKey: ['client-receipts', entityId],
    queryFn: () =>
      api.request<
        {
          id: string;
          receivedOn: string;
          party: string;
          amount: string;
          tds: string;
          reference: string;
          status: string;
          voucher: string;
        }[]
      >(`/api/tenant/accounts/client-receipts?entityId=${entityId}`),
  });
  if (!list.data?.length) return null;
  return (
    <Card title="Receipts">
      <Table minWidth="40rem">
        <thead>
          <tr>
            <th>Date</th>
            <th>Voucher</th>
            <th>Client</th>
            <th className="text-right">Received</th>
            <th className="text-right">TDS</th>
          </tr>
        </thead>
        <tbody aria-label="Client receipts">
          {list.data.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{shortDate(r.receivedOn)}</td>
              <td>
                <Link
                  to="/accounts/client-receipts/$receiptId"
                  params={{ receiptId: r.id }}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {r.voucher}
                </Link>{' '}
                {r.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
              </td>
              <td className="text-sm">{r.party}</td>
              <td className="text-right tabular-nums">{rupees(r.amount)}</td>
              <td className="text-right tabular-nums">{Number(r.tds) ? rupees(r.tds) : ''}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

interface OpenItems {
  bills: {
    id: string;
    raNo: number;
    project: { id: string; number: string; name: string };
    invoiceNo: string;
    invoiceDate: string;
    outstanding: string;
  }[];
  projects: {
    project: { id: string; number: string; name: string };
    retentionOpen: string;
    advanceReceived: string;
    advanceRecovered: string;
  }[];
}
const paise = (v: string) => Math.round(Number((v || '0').replace(/,/g, '')) * 100);
const fromPaise = (p: number) => (p / 100).toFixed(2);

export function NewClientReceiptScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chart = useChart();
  const clients = useQuery({
    queryKey: ['parties', 'clients'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=client'),
  });
  const [partyId, setPartyId] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());
  const [bankId, setBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [tds, setTds] = useState('');
  const [gstTds, setGstTds] = useState('');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [deductions, setDeductions] = useState<
    { description: string; amount: string; accountId: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banks = (chart.data?.accounts ?? []).filter(
    (a) => (a.kind === 'bank' || a.kind === 'cash') && !a.closed,
  );
  return (
    <Books title="Record a receipt">
      {(entityId) => (
        <ReceiptForm
          {...{
            entityId,
            partyId,
            setPartyId,
            receivedOn,
            setReceivedOn,
            bankId,
            setBankId,
            amount,
            setAmount,
            tds,
            setTds,
            gstTds,
            setGstTds,
            reference,
            setReference,
            alloc,
            setAlloc,
            deductions,
            setDeductions,
            busy,
            error,
            banks,
          }}
          clients={clients.data ?? []}
          ledgers={ledgerOptions((chart.data?.accounts ?? []).filter((a) => a.kind !== 'party'))}
          onSubmit={async (body) => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.request<{ id: string }>('/api/tenant/accounts/client-receipts', {
                method: 'POST',
                body,
              });
              void qc.invalidateQueries({ queryKey: ['receivables'] });
              void qc.invalidateQueries({ queryKey: ['client-receipts'] });
              await navigate({
                to: '/accounts/client-receipts/$receiptId',
                params: { receiptId: r.id },
              });
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Books>
  );
}

function ReceiptForm(p: {
  entityId: string;
  partyId: string;
  setPartyId: (v: string) => void;
  receivedOn: string;
  setReceivedOn: (v: string) => void;
  bankId: string;
  setBankId: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  tds: string;
  setTds: (v: string) => void;
  gstTds: string;
  setGstTds: (v: string) => void;
  reference: string;
  setReference: (v: string) => void;
  alloc: Record<string, string>;
  setAlloc: (v: Record<string, string>) => void;
  deductions: { description: string; amount: string; accountId: string }[];
  setDeductions: (v: { description: string; amount: string; accountId: string }[]) => void;
  busy: boolean;
  error: string | null;
  banks: { id: string; code: string; name: string }[];
  clients: Party[];
  ledgers: { id: string; label: string }[];
  onSubmit: (body: object) => Promise<void>;
}) {
  const items = useQuery({
    queryKey: ['open-items', p.entityId, p.partyId],
    queryFn: () =>
      api.request<OpenItems>(
        `/api/tenant/accounts/open-items?entityId=${p.entityId}&partyId=${p.partyId}`,
      ),
    enabled: !!p.partyId,
  });
  const settled =
    paise(p.amount) +
    paise(p.tds) +
    paise(p.gstTds) +
    p.deductions.reduce((s, d) => s + paise(d.amount), 0);
  const allocated = Object.values(p.alloc).reduce((s, v) => s + paise(v), 0);
  const oldestFirst = () => {
    let left = settled;
    const next: Record<string, string> = {};
    for (const b of items.data?.bills ?? []) {
      if (left <= 0) break;
      const take = Math.min(left, paise(b.outstanding));
      next[`bill:${b.id}`] = fromPaise(take);
      left -= take;
    }
    p.setAlloc(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const allocations = Object.entries(p.alloc)
      .filter(([, v]) => paise(v) > 0)
      .map(([k, v]) => {
        const [kind, id] = k.split(':') as ['bill' | 'retention' | 'advance', string];
        return {
          kind,
          billId: kind === 'bill' ? id : null,
          projectId: kind === 'bill' ? null : id,
          amount: v.replace(/,/g, ''),
        };
      });
    void p.onSubmit({
      entityId: p.entityId,
      partyId: p.partyId,
      receivedOn: p.receivedOn,
      bankAccountId: p.bankId,
      amount: p.amount.replace(/,/g, ''),
      tds: p.tds.replace(/,/g, '') || '0',
      gstTds: p.gstTds.replace(/,/g, '') || '0',
      reference: p.reference,
      allocations,
      deductions: p.deductions,
    });
  };
  const field = (key: string, label: string, hint?: string) => (
    <Input
      aria-label={label}
      title={hint}
      className="w-32 text-right"
      inputMode="decimal"
      value={p.alloc[key] ?? ''}
      onChange={(e) => p.setAlloc({ ...p.alloc, [key]: e.target.value })}
    />
  );
  return (
    <form onSubmit={submit} className="space-y-5" aria-label="Receipt">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Client">
            <Select
              value={p.partyId}
              onChange={(e) => {
                p.setPartyId(e.target.value);
                p.setAlloc({});
              }}
              required
            >
              <option value="">Choose the client</option>
              {p.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Received on">
            <Input
              type="date"
              value={p.receivedOn}
              onChange={(e) => p.setReceivedOn(e.target.value)}
              required
            />
          </Field>
          <Field label="Into">
            <Select value={p.bankId} onChange={(e) => p.setBankId(e.target.value)} required>
              <option value="">Bank or cash</option>
              {p.banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount received ₹">
            <Input
              value={p.amount}
              onChange={(e) => p.setAmount(e.target.value)}
              inputMode="decimal"
              required
            />
          </Field>
          <Field label="TDS deducted ₹">
            <Input value={p.tds} onChange={(e) => p.setTds(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="GST TDS deducted ₹" hint="2% by a government client (section 51)">
            <Input
              value={p.gstTds}
              onChange={(e) => p.setGstTds(e.target.value)}
              inputMode="decimal"
            />
          </Field>
          <Field label="UTR or cheque no.">
            <Input
              value={p.reference}
              onChange={(e) => p.setReference(e.target.value)}
              maxLength={100}
            />
          </Field>
        </div>
        <div className="mt-3 space-y-2">
          {p.deductions.map((d, i) => (
            <fieldset
              key={i}
              aria-label={`Deduction ${i + 1}`}
              className="grid gap-2 sm:grid-cols-[1fr_9rem_16rem_auto]"
            >
              <Input
                aria-label="What"
                placeholder="Security deposit"
                value={d.description}
                onChange={(e) =>
                  p.setDeductions(
                    p.deductions.map((x, j) =>
                      j === i ? { ...x, description: e.target.value } : x,
                    ),
                  )
                }
              />
              <Input
                aria-label="Amount"
                value={d.amount}
                onChange={(e) =>
                  p.setDeductions(
                    p.deductions.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              <Select
                aria-label="Ledger"
                value={d.accountId}
                onChange={(e) =>
                  p.setDeductions(
                    p.deductions.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)),
                  )
                }
              >
                <option value="">Posts to which ledger?</option>
                {p.ledgers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove deduction ${i + 1}`}
                onClick={() => p.setDeductions(p.deductions.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              p.setDeductions([...p.deductions, { description: '', amount: '', accountId: '' }])
            }
          >
            <Plus className="size-4" aria-hidden /> Another deduction by the client
          </Button>
        </div>
      </Card>
      {p.partyId && (
        <Card
          title="What it settles"
          actions={
            <Button type="button" variant="secondary" onClick={oldestFirst} disabled={!settled}>
              Oldest bills first
            </Button>
          }
        >
          {items.isPending ? (
            <Spinner />
          ) : items.isError ? (
            <Alert tone="danger">{describeError(items.error)}</Alert>
          ) : (
            <Table minWidth="40rem">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Open</th>
                  <th className="text-right">This receipt</th>
                </tr>
              </thead>
              <tbody aria-label="Open items">
                {items.data.bills.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.project.number} RA {b.raNo}{' '}
                      <span className="text-xs text-fg-muted">
                        {b.invoiceNo}, {shortDate(b.invoiceDate)}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{rupees(b.outstanding)}</td>
                    <td className="text-right">
                      {field(`bill:${b.id}`, `Settle ${b.project.number} RA ${b.raNo}`)}
                    </td>
                  </tr>
                ))}
                {items.data.projects.map((x) => (
                  <tr key={`r-${x.project.id}`}>
                    <td>{x.project.number} retention released</td>
                    <td className="text-right tabular-nums">{rupees(x.retentionOpen)}</td>
                    <td className="text-right">
                      {field(`retention:${x.project.id}`, `Retention of ${x.project.number}`)}
                    </td>
                  </tr>
                ))}
                {items.data.projects.map((x) => (
                  <tr key={`a-${x.project.id}`}>
                    <td>{x.project.number} mobilisation advance</td>
                    <td />
                    <td className="text-right">
                      {field(`advance:${x.project.id}`, `Advance for ${x.project.number}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="mt-3 text-sm tabular-nums" aria-label="Allocation">
            Settles {rupees(fromPaise(settled))}; allocated {rupees(fromPaise(allocated))}
            {settled !== allocated && (
              <span className="font-medium text-danger">
                {' '}
                — {rupees(fromPaise(Math.abs(settled - allocated)))}{' '}
                {settled > allocated ? 'still to allocate' : 'too much'}
              </span>
            )}
          </p>
        </Card>
      )}
      {p.error && <Alert tone="danger">{p.error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={p.busy} disabled={!settled || settled !== allocated}>
          Record the receipt
        </Button>
        <Link
          to="/accounts/receivables"
          className="px-3 py-2 text-sm text-fg-muted hover:underline"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

interface Receipt {
  id: string;
  company: string;
  party: { id: string; name: string };
  receivedOn: string;
  bank: { code: string; name: string };
  amount: string;
  tds: string;
  gstTds: string;
  reference: string;
  narration: string;
  status: 'posted' | 'cancelled';
  statusReason: string | null;
  voucher: { id: string; number: string };
  cancelVoucher: { id: string; number: string } | null;
  allocations: {
    kind: 'bill' | 'retention' | 'advance';
    amount: string;
    billId: string | null;
    raNo: number | null;
    invoiceNo: string | null;
    project: { number: string };
  }[];
  deductions: { description: string; amount: string; account: { code: string; name: string } }[];
  mayCancel: boolean;
}

export function ClientReceiptScreen({ receiptId }: { receiptId: string }) {
  const qc = useQueryClient();
  const key = ['client-receipt', receiptId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Receipt>(`/api/tenant/accounts/client-receipts/${receiptId}`),
  });
  const [error, setError] = useState<string | null>(null);
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const x = r.data;
  const cancel = () => {
    const reason = window.prompt('Why is the receipt cancelled?');
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    void api
      .request<Receipt>(`/api/tenant/accounts/client-receipts/${x.id}/cancel`, {
        method: 'POST',
        body: { date: today(), reason: reason.trim() },
      })
      .then((next) => {
        qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: ['receivables'] });
      })
      .catch((err: unknown) => setError(describeError(err)));
  };
  return (
    <div className="space-y-5">
      <Link
        to="/accounts/receivables"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Receivables
      </Link>
      <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
        Receipt from {x.party.name}{' '}
        {x.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
        <Link
          to="/print/client-receipts/$receiptId"
          params={{ receiptId: x.id }}
          className={`ml-auto ${printLink}`}
        >
          Print the receipt
        </Link>
      </h1>
      {x.statusReason && <Alert tone="info">Cancelled: {x.statusReason}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        actions={
          x.mayCancel && (
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel the receipt
            </Button>
          )
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">Received</dt>
          <dd>
            {rupees(x.amount)} on {shortDate(x.receivedOn)} into {x.bank.code} {x.bank.name}
            {x.reference && ` (${x.reference})`}
          </dd>
          {Number(x.tds) > 0 && (
            <>
              <dt className="text-fg-muted">TDS deducted</dt>
              <dd>{rupees(x.tds)}</dd>
            </>
          )}
          {Number(x.gstTds) > 0 && (
            <>
              <dt className="text-fg-muted">GST TDS deducted</dt>
              <dd>{rupees(x.gstTds)}</dd>
            </>
          )}
          {x.deductions.map((d, i) => (
            <span key={i} className="contents">
              <dt className="text-fg-muted">{d.description}</dt>
              <dd>
                {rupees(d.amount)}{' '}
                <span className="text-xs text-fg-muted">to {d.account.name}</span>
              </dd>
            </span>
          ))}
          <dt className="text-fg-muted">Voucher</dt>
          <dd>
            <Link
              to="/accounts/vouchers/$voucherId"
              params={{ voucherId: x.voucher.id }}
              className="text-accent hover:underline"
            >
              {x.voucher.number}
            </Link>
            {x.cancelVoucher && (
              <>
                {', reversed by '}
                <Link
                  to="/accounts/vouchers/$voucherId"
                  params={{ voucherId: x.cancelVoucher.id }}
                  className="text-accent hover:underline"
                >
                  {x.cancelVoucher.number}
                </Link>
              </>
            )}
          </dd>
        </dl>
      </Card>
      <Card title="It settled">
        <Table minWidth="30rem">
          <tbody aria-label="Allocations">
            {x.allocations.map((a, i) => (
              <tr key={i}>
                <td>
                  {a.kind === 'bill' && a.billId ? (
                    <Link
                      to="/client-bills/$billId"
                      params={{ billId: a.billId }}
                      className="text-accent hover:underline"
                    >
                      {a.project.number} RA {a.raNo} ({a.invoiceNo})
                    </Link>
                  ) : a.kind === 'retention' ? (
                    `${a.project.number} retention released`
                  ) : (
                    `${a.project.number} mobilisation advance`
                  )}
                </td>
                <td className="text-right tabular-nums">{rupees(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
