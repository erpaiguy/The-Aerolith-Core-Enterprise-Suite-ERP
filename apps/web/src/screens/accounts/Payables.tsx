// Payables (docs/wave3-plan.md step 4): what is owed to suppliers, aged from the due dates; their bills, entered
// against an order (matched to it and its receipts, held when they do not match) or to a ledger; debit notes and
// advances; payment runs approved under the rules, with a file for the bank, marked paid.
import { MsmeCard } from './Msme';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataGrid,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  toast,
  useConfirm,
  type GridColumn,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, FileSpreadsheet, Plus, Printer, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, saveFile } from '../../api/client';
import type { Party, ProjectSummary } from '../../api/types';
import { RCM_LABELS, ledgerOptions, today, useChart } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { day, num, useGridStorage } from '../../lib/grid';
import type { Order, OrderRow } from '../../procurement/orders';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from './Vouchers';
import { printLink } from '../../print/Letterhead';
import { PurchaseFlow } from '../shell/FlowStrip';

const plusDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const STATUS_TONE = { held: 'warning', posted: 'success', cancelled: 'danger' } as const;
const RUN_TONE = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'accent',
  paid: 'success',
  cancelled: 'danger',
} as const;

interface BillRow {
  id: string;
  party: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  status: 'held' | 'posted' | 'cancelled';
  total: string;
  tds: string;
  payable: string;
  outstanding: string;
  order: string | null;
}

export function PayablesScreen() {
  const [asOf, setAsOf] = useState(today());
  const mayPost = usePermission('accounts.post');
  return (
    <Books
      title="Payables"
      actions={
        mayPost && (
          <div className="flex gap-2">
            <Link
              to="/accounts/vendor-bills/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
            >
              <Plus className="size-4" aria-hidden /> Enter a bill
            </Link>
            <Link
              to="/accounts/payment-runs/new"
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              New payment run
            </Link>
          </div>
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
                    `/api/tenant/accounts/payables?entityId=${entityId}&asOf=${asOf}&format=xlsx`,
                  )
                  .then(({ blob, fileName }) => saveFile(blob, fileName))
              }
            >
              <FileSpreadsheet className="size-4" aria-hidden /> Excel
            </Button>
          </div>
          <Ageing entityId={entityId} asOf={asOf} />
          <MsmeCard entityId={entityId} asOf={asOf} />
          <BillList entityId={entityId} />
          <RunList entityId={entityId} />
          <Tolerance />
        </>
      )}
    </Books>
  );
}

function Ageing({ entityId, asOf }: { entityId: string; asOf: string }) {
  const r = useQuery({
    queryKey: ['payables', entityId, asOf],
    queryFn: () =>
      api.request<{
        buckets: string[];
        suppliers: {
          party: { id: string; name: string };
          buckets: string[];
          outstanding: string;
          advance: string;
        }[];
        total: string;
      }>(`/api/tenant/accounts/payables?entityId=${entityId}&asOf=${asOf}`),
    placeholderData: keepPreviousData,
  });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  return (
    <Card title={`Owed to suppliers: ${rupees(r.data.total)}`}>
      {r.data.suppliers.length === 0 ? (
        <EmptyState title="Nothing is owed.">
          Suppliers&apos; bills entered here and not yet paid show by how long they are overdue.
        </EmptyState>
      ) : (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Supplier</th>
              {r.data.buckets.map((b) => (
                <th key={b} className="text-right">
                  {b === 'not due' ? 'Not due' : `${b} days overdue`}
                </th>
              ))}
              <th className="text-right">Outstanding</th>
              <th className="text-right">Advance</th>
            </tr>
          </thead>
          <tbody aria-label="Payables by supplier">
            {r.data.suppliers.map((s) => (
              <tr key={s.party.id}>
                <td>{s.party.name}</td>
                {s.buckets.map((v, i) => (
                  <td key={i} className="text-right tabular-nums">
                    {Number(v) ? rupees(v) : ''}
                  </td>
                ))}
                <td className="text-right font-medium tabular-nums">{rupees(s.outstanding)}</td>
                <td className="text-right tabular-nums">
                  {Number(s.advance) ? rupees(s.advance) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const BILL_STATUS = { held: 'Held', posted: 'Posted', cancelled: 'Cancelled' } as const;

const BILL_COLUMNS: GridColumn<BillRow>[] = [
  {
    id: 'party',
    header: 'Supplier',
    width: 200,
    value: (b) => b.party,
    cell: (b) => <span className="text-sm">{b.party}</span>,
  },
  {
    id: 'bill',
    header: 'Bill',
    width: 220,
    hideable: false,
    value: (b) => b.billNo,
    cell: (b) => (
      <>
        <Link
          to="/accounts/vendor-bills/$billId"
          params={{ billId: b.id }}
          className="text-accent hover:underline"
        >
          {b.billNo}
        </Link>{' '}
        <span className="text-xs text-fg-muted">
          {shortDate(b.billDate)}
          {b.order && ` · ${b.order}`}
        </span>
      </>
    ),
  },
  {
    id: 'due',
    header: 'Due',
    width: 110,
    value: (b) => day(b.dueDate),
    cell: (b) => <span className="whitespace-nowrap">{shortDate(b.dueDate)}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    width: 110,
    value: (b) => BILL_STATUS[b.status],
    cell: (b) => <Badge tone={STATUS_TONE[b.status]}>{BILL_STATUS[b.status]}</Badge>,
  },
  {
    id: 'total',
    header: 'Total',
    align: 'right',
    width: 130,
    value: (b) => num(b.total),
    cell: (b) => rupees(b.total),
  },
  {
    id: 'tds',
    header: 'TDS',
    align: 'right',
    width: 110,
    value: (b) => (Number(b.tds) ? num(b.tds) : null),
    cell: (b) => (Number(b.tds) ? rupees(b.tds) : ''),
  },
  {
    id: 'outstanding',
    header: 'Outstanding',
    align: 'right',
    width: 130,
    value: (b) => (b.status === 'posted' ? num(b.outstanding) : null),
    cell: (b) => (b.status === 'posted' ? rupees(b.outstanding) : ''),
  },
];

function BillList({ entityId }: { entityId: string }) {
  const [status, setStatus] = useState('');
  const storage = useGridStorage('vendor-bills');
  const list = useQuery({
    queryKey: ['vendor-bills', entityId, status],
    queryFn: () =>
      api.request<BillRow[]>(
        `/api/tenant/accounts/vendor-bills?entityId=${entityId}${status ? `&status=${status}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      title="Suppliers' bills"
      actions={
        <Select
          aria-label="Bill status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
        >
          <option value="">All</option>
          <option value="held">Held</option>
          <option value="posted">Posted</option>
          <option value="cancelled">Cancelled</option>
        </Select>
      }
    >
      <DataGrid
        id="vendor-bills"
        label="Vendor bills"
        columns={BILL_COLUMNS}
        rows={list.data ?? []}
        rowKey={(b) => b.id}
        storage={storage}
        exportName="Suppliers' bills"
        empty={<EmptyState title="None.">Bills entered with Enter a bill show here.</EmptyState>}
      />
    </Card>
  );
}

function RunList({ entityId }: { entityId: string }) {
  const list = useQuery({
    queryKey: ['payment-runs', entityId],
    queryFn: () =>
      api.request<
        {
          id: string;
          number: string;
          payOn: string;
          status: keyof typeof RUN_TONE;
          total: string;
          suppliers: number;
        }[]
      >(`/api/tenant/accounts/payment-runs?entityId=${entityId}`),
  });
  if (!list.data?.length) return null;
  return (
    <Card title="Payment runs">
      <Table minWidth="32rem">
        <thead>
          <tr>
            <th>Run</th>
            <th>Pay on</th>
            <th>Status</th>
            <th>Suppliers</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody aria-label="Payment runs">
          {list.data.map((r) => (
            <tr key={r.id}>
              <td>
                <Link
                  to="/accounts/payment-runs/$runId"
                  params={{ runId: r.id }}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {r.number}
                </Link>
              </td>
              <td>{shortDate(r.payOn)}</td>
              <td>
                <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
              </td>
              <td className="text-sm">{r.suppliers} suppliers</td>
              <td className="text-right tabular-nums">{rupees(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

interface DraftLine {
  lineKey: string | null;
  accountId: string;
  projectId: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
  gstPct: string;
  note?: string;
}

export function NewVendorBillScreen() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chart = useChart();
  const suppliers = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties'),
  });
  const orders = useQuery({
    queryKey: ['orders', 'all'],
    queryFn: () => api.request<OrderRow[]>('/api/tenant/orders'),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all-for-books'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
  });
  const [partyId, setPartyId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState(plusDays(today(), 30));
  const [tdsSection, setTdsSection] = useState('');
  const [rcm, setRcm] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const party = suppliers.data?.find((p) => p.id === partyId);
  const theirOrders = (orders.data ?? []).filter(
    (o) => o.vendor === party?.name && ['issued', 'acknowledged', 'closed'].includes(o.status),
  );
  const blankLine = (): DraftLine => ({
    lineKey: null,
    accountId: '',
    projectId: '',
    description: '',
    unit: '',
    qty: '1',
    rate: '',
    gstPct: '18',
  });
  const chooseOrder = async (id: string) => {
    setOrderId(id);
    if (!id) {
      setLines([blankLine()]);
      return;
    }
    const o = await api.request<Order>(`/api/tenant/orders/${id}`);
    setLines(
      (o.inForce?.lines ?? []).map((l) => {
        const p = o.progress.find((x) => x.lineKey === l.lineKey);
        return {
          lineKey: l.lineKey,
          accountId: '',
          projectId: '',
          description: l.description,
          unit: l.unit,
          qty: o.kind === 'work' ? '' : String(Number(p?.accepted ?? '0') || ''),
          rate: String(Number(l.rate)),
          gstPct: l.gstPct,
          note:
            o.kind === 'work'
              ? `ordered ${Number(l.qty)}`
              : `accepted ${Number(p?.accepted ?? 0)} of ${Number(l.qty)}`,
        };
      }),
    );
  };
  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ledgers = ledgerOptions(
    (chart.data?.accounts ?? []).filter((a) => a.kind === 'ordinary' || a.kind === 'tax'),
  );
  return (
    <Books title="Enter a supplier's bill">
      {(entityId) => {
        const submit = async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const b = await api.request<{ id: string }>('/api/tenant/accounts/vendor-bills', {
              method: 'POST',
              body: {
                entityId,
                partyId,
                orderId: orderId || null,
                billNo,
                billDate,
                dueDate,
                tdsSection: tdsSection || null,
                reverseCharge: rcm || null,
                lines: lines
                  .filter((l) => Number(l.qty) > 0)
                  .map((l) => ({
                    lineKey: l.lineKey,
                    accountId: l.lineKey ? null : l.accountId || null,
                    projectId: l.projectId || null,
                    description: l.description,
                    unit: l.unit || null,
                    qty: l.qty,
                    rate: l.rate || '0',
                    gstPct: l.gstPct,
                  })),
              },
            });
            void qc.invalidateQueries({ queryKey: ['vendor-bills'] });
            void qc.invalidateQueries({ queryKey: ['payables'] });
            toast.success(`Bill ${billNo} entered`);
            await navigate({ to: '/accounts/vendor-bills/$billId', params: { billId: b.id } });
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        };
        return (
          <form onSubmit={(e) => void submit(e)} className="space-y-5" aria-label="Supplier's bill">
            <Card>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Supplier">
                  <Select
                    value={partyId}
                    onChange={(e) => {
                      setPartyId(e.target.value);
                      setOrderId('');
                      setLines([blankLine()]);
                      const chosen = suppliers.data?.find((p) => p.id === e.target.value);
                      setTdsSection(chosen?.tdsSection ?? '');
                      setRcm(chosen?.rcmCategory ?? '');
                    }}
                    required
                  >
                    <option value="">Choose the supplier</option>
                    {(suppliers.data ?? [])
                      .filter((p) => p.isVendor || p.isSubcontractor)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Against an order">
                  <Select
                    value={orderId}
                    onChange={(e) => void chooseOrder(e.target.value)}
                    disabled={!partyId}
                  >
                    <option value="">No order (an expense)</option>
                    {theirOrders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.number} · {o.project.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Their bill no.">
                  <Input
                    value={billNo}
                    onChange={(e) => setBillNo(e.target.value)}
                    required
                    maxLength={60}
                  />
                </Field>
                <Field label="Bill date">
                  <Input
                    type="date"
                    value={billDate}
                    onChange={(e) => {
                      setBillDate(e.target.value);
                      setDueDate(plusDays(e.target.value, 30));
                    }}
                    required
                  />
                </Field>
                <Field label="Due">
                  <Input
                    type="date"
                    value={dueDate}
                    min={billDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    required
                  />
                </Field>
                <Field label="TDS section">
                  <Select value={tdsSection} onChange={(e) => setTdsSection(e.target.value)}>
                    <option value="">None</option>
                    <option value="194C">194C contractors</option>
                    <option value="194J">194J professional fees</option>
                    <option value="194I">194I rent</option>
                    <option value="194Q">194Q purchase of goods</option>
                  </Select>
                </Field>
                <Field label="GST reverse charge" hint="The supplier charges no GST; we pay it">
                  <Select value={rcm} onChange={(e) => setRcm(e.target.value)}>
                    <option value="">No</option>
                    {Object.entries(RCM_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Card>
            {partyId && (
              <Card title="Lines">
                <div className="space-y-2">
                  {lines.map((l, i) => (
                    <fieldset
                      key={i}
                      aria-label={`Bill line ${i + 1}`}
                      className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_6rem_auto]"
                    >
                      {l.lineKey ? (
                        <div className="text-sm">
                          {l.description}{' '}
                          <span className="text-xs text-fg-muted">
                            {l.unit}, {l.note}
                          </span>
                        </div>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Select
                            aria-label="Ledger"
                            value={l.accountId}
                            onChange={(e) => set(i, { accountId: e.target.value })}
                            required
                          >
                            <option value="">Ledger</option>
                            {ledgers.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                          <Input
                            aria-label="Description"
                            placeholder="What"
                            value={l.description}
                            onChange={(e) => set(i, { description: e.target.value })}
                            required
                          />
                          <Select
                            aria-label="Project"
                            value={l.projectId}
                            onChange={(e) => set(i, { projectId: e.target.value })}
                            className="sm:col-span-2"
                          >
                            <option value="">No project</option>
                            {(projects.data?.items ?? []).map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.number} · {p.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      <Input
                        aria-label="Quantity"
                        className="text-right"
                        value={l.qty}
                        onChange={(e) => set(i, { qty: e.target.value })}
                        inputMode="decimal"
                      />
                      <Input
                        aria-label="Rate"
                        className="text-right"
                        value={l.rate}
                        onChange={(e) => set(i, { rate: e.target.value })}
                        inputMode="decimal"
                      />
                      <Input
                        aria-label="GST %"
                        className="text-right"
                        value={l.gstPct}
                        disabled={!!l.lineKey}
                        onChange={(e) => set(i, { gstPct: e.target.value })}
                      />
                      {!l.lineKey && (
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={`Remove line ${i + 1}`}
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </fieldset>
                  ))}
                  {!orderId && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setLines([...lines, blankLine()])}
                    >
                      <Plus className="size-4" aria-hidden /> Add a line
                    </Button>
                  )}
                </div>
              </Card>
            )}
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" busy={busy} disabled={!partyId || !lines.length}>
                Enter the bill
              </Button>
              <Link
                to="/accounts/payables"
                className="px-3 py-2 text-sm text-fg-muted hover:underline"
              >
                Cancel
              </Link>
            </div>
          </form>
        );
      }}
    </Books>
  );
}

interface VendorBill {
  id: string;
  party: { id: string; name: string; gstin: string | null };
  order: { id: string; number: string; kind: string } | null;
  project: { id: string; number: string; name: string } | null;
  billNo: string;
  billDate: string;
  dueDate: string;
  supply: string;
  status: 'held' | 'posted' | 'cancelled';
  heldReasons: string[];
  passReason: string | null;
  statusReason: string | null;
  tdsSection: string | null;
  reverseCharge: string | null;
  reverseChargeTax: Record<'cgst' | 'sgst' | 'igst' | 'blocked', string>;
  tdsRate: string;
  tdsBase: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  tds: string;
  payable: string;
  outstanding: string;
  voucher: { id: string; number: string } | null;
  lines: {
    position: number;
    description: string;
    unit: string | null;
    qty: string;
    rate: string;
    gstPct: string;
    amount: string;
    gst: string;
    account: { code: string; name: string };
  }[];
  debitNotes: { id: string; date: string; reason: string; total: string }[];
  payments: { run: string; runId: string; paidOn: string; amount: string }[];
  advancesApplied: { date: string; amount: string }[];
  mayPass: boolean;
  mayCancel: boolean;
}

export function VendorBillScreen({ billId }: { billId: string }) {
  const qc = useQueryClient();
  const key = ['vendor-bill', billId];
  const b = useQuery({
    queryKey: key,
    queryFn: () => api.request<VendorBill>(`/api/tenant/accounts/vendor-bills/${billId}`),
  });
  const mayPost = usePermission('accounts.post');
  const [error, setError] = useState<string | null>(null);
  const [dn, setDn] = useState({ taxable: '', gstPct: '18', reason: '' });
  const [advance, setAdvance] = useState('');
  const confirm = useConfirm();
  if (b.isPending) return <Spinner />;
  if (b.isError) return <Alert tone="danger">{describeError(b.error)}</Alert>;
  const x = b.data;
  const act = (path: string, body: object, said: string) => {
    setError(null);
    void api
      .request<VendorBill>(`/api/tenant/accounts/vendor-bills/${x.id}/${path}`, {
        method: 'POST',
        body,
      })
      .then((next) => {
        qc.setQueryData(key, next);
        toast.success(said);
        void qc.invalidateQueries({ queryKey: ['payables'] });
        void qc.invalidateQueries({ queryKey: ['vendor-bills'] });
      })
      .catch((err: unknown) => setError(describeError(err)));
  };
  const ask = (q: string) => {
    const r = window.prompt(q);
    return r && r.trim().length >= 3 ? r.trim() : null;
  };
  return (
    <div className="space-y-5">
      <Link
        to="/accounts/payables"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Payables
      </Link>
      <h1 className="text-xl font-semibold">
        {x.party.name} bill {x.billNo}{' '}
        <Badge tone={STATUS_TONE[x.status]}>
          {x.status === 'held' ? 'Held' : x.status === 'posted' ? 'Posted' : 'Cancelled'}
        </Badge>
      </h1>
      <PurchaseFlow kind="bill" id={x.id} stamp={`${x.status}-${x.outstanding}`} />
      {x.status === 'held' && (
        <Alert tone="warning">
          <div className="font-medium">Held: it does not match the order and receipts.</div>
          <ul className="list-disc pl-5" aria-label="Why held">
            {x.heldReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      )}
      {x.passReason && <Alert>Passed: {x.passReason}</Alert>}
      {x.statusReason && <Alert tone="info">Cancelled: {x.statusReason}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        actions={
          <div className="flex gap-2">
            {x.mayPass && (
              <Button
                type="button"
                onClick={() => {
                  const r = ask('Why is the bill passed despite the difference?');
                  if (r) act('pass', { reason: r }, `Bill ${x.billNo} passed and posted`);
                }}
              >
                Pass the bill
              </Button>
            )}
            {x.mayCancel && (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Cancel ${x.party.name}'s bill ${x.billNo}?`,
                      body: 'The bill is cancelled for good and its voucher, if any, is reversed. You will be asked why.',
                      confirmLabel: 'Cancel the bill',
                      tone: 'danger',
                    }))
                  )
                    return;
                  const r = ask('Why is the bill cancelled?');
                  if (r) act('cancel', { reason: r, date: today() }, `Bill ${x.billNo} cancelled`);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">Dated</dt>
          <dd>
            {shortDate(x.billDate)}, due {shortDate(x.dueDate)}
          </dd>
          {x.order && (
            <>
              <dt className="text-fg-muted">Order</dt>
              <dd>
                <Link
                  to="/orders/$orderId"
                  params={{ orderId: x.order.id }}
                  className="text-accent hover:underline"
                >
                  {x.order.number}
                </Link>
              </dd>
            </>
          )}
          <dt className="text-fg-muted">GST</dt>
          <dd>
            {x.reverseCharge
              ? `Reverse charge (${RCM_LABELS[x.reverseCharge] ?? x.reverseCharge}): we pay ${rupees(
                  String(
                    Number(x.reverseChargeTax.cgst) +
                      Number(x.reverseChargeTax.sgst) +
                      Number(x.reverseChargeTax.igst),
                  ),
                )}`
              : x.supply === 'intra'
                ? 'CGST and SGST'
                : x.supply === 'inter'
                  ? 'IGST'
                  : 'None (unregistered)'}
          </dd>
          {x.tdsSection && (
            <>
              <dt className="text-fg-muted">TDS {x.tdsSection}</dt>
              <dd>
                {Number(x.tds)
                  ? `${rupees(x.tds)} at ${Number(x.tdsRate)}% on ${rupees(x.tdsBase)}`
                  : 'Not yet due (under the limits)'}
              </dd>
            </>
          )}
          {x.voucher && (
            <>
              <dt className="text-fg-muted">Voucher</dt>
              <dd>
                <Link
                  to="/accounts/vouchers/$voucherId"
                  params={{ voucherId: x.voucher.id }}
                  className="text-accent hover:underline"
                >
                  {x.voucher.number}
                </Link>
              </dd>
            </>
          )}
        </dl>
        <div className="mt-4" />
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Line</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Amount</th>
              <th className="text-right">GST</th>
            </tr>
          </thead>
          <tbody aria-label="Bill lines">
            {x.lines.map((l) => (
              <tr key={l.position}>
                <td>
                  {l.description} <span className="text-xs text-fg-muted">to {l.account.name}</span>
                </td>
                <td className="text-right tabular-nums">
                  {Number(l.qty)} {l.unit}
                </td>
                <td className="text-right tabular-nums">{rupees(l.rate)}</td>
                <td className="text-right tabular-nums">{rupees(l.amount)}</td>
                <td className="text-right tabular-nums">{Number(l.gst) ? rupees(l.gst) : ''}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div
          className="mt-3 flex flex-wrap justify-end gap-4 text-sm tabular-nums"
          aria-label="Bill totals"
        >
          <span>Total {rupees(x.total)}</span>
          {Number(x.tds) > 0 && <span>TDS {rupees(x.tds)}</span>}
          <span className="font-semibold">Payable {rupees(x.payable)}</span>
          {x.status === 'posted' && (
            <span className="font-semibold">Outstanding {rupees(x.outstanding)}</span>
          )}
        </div>
      </Card>
      {(x.payments.length > 0 || x.debitNotes.length > 0 || x.advancesApplied.length > 0) && (
        <Card title="Settled by">
          <ul className="space-y-1 text-sm" aria-label="Settled by">
            {x.payments.map((p, i) => (
              <li key={`p${i}`}>
                {rupees(p.amount)} paid on {shortDate(p.paidOn)} in{' '}
                <Link
                  to="/accounts/payment-runs/$runId"
                  params={{ runId: p.runId }}
                  className="text-accent hover:underline"
                >
                  {p.run}
                </Link>
              </li>
            ))}
            {x.debitNotes.map((d) => (
              <li key={d.id}>
                Debit note {rupees(d.total)} on {shortDate(d.date)}: {d.reason}
              </li>
            ))}
            {x.advancesApplied.map((a, i) => (
              <li key={`a${i}`}>
                Advance {rupees(a.amount)} applied on {shortDate(a.date)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {mayPost && x.status === 'posted' && Number(x.outstanding) > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Debit note">
            <form
              className="space-y-3"
              aria-label="Debit note"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  !(await confirm({
                    title: `Raise a debit note on ${x.party.name} for ${rupees(dn.taxable)} before GST?`,
                    body: 'The debit note is posted to the books against this bill and goes into the GST returns. It cannot be withdrawn.',
                    confirmLabel: 'Raise the debit note',
                    tone: 'primary',
                  }))
                )
                  return;
                act('debit-notes', { date: today(), ...dn }, 'Debit note raised');
              }}
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
                <Field label="Value before GST ₹">
                  <Input
                    value={dn.taxable}
                    onChange={(e) => setDn({ ...dn, taxable: e.target.value })}
                    required
                  />
                </Field>
                <Field label="GST %">
                  <Input
                    value={dn.gstPct}
                    onChange={(e) => setDn({ ...dn, gstPct: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Why">
                <Input
                  value={dn.reason}
                  onChange={(e) => setDn({ ...dn, reason: e.target.value })}
                  required
                  minLength={3}
                />
              </Field>
              <Button type="submit">Raise the debit note</Button>
            </form>
          </Card>
          <Card title="Apply an advance">
            <form
              className="flex flex-wrap items-end gap-3"
              aria-label="Apply an advance"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  !(await confirm({
                    title: `Apply ${rupees(advance)} of advance to bill ${x.billNo}?`,
                    body: "The supplier's advance is set off against the bill by a journal posted to the books.",
                    confirmLabel: 'Apply the advance',
                    tone: 'primary',
                  }))
                )
                  return;
                act('apply-advance', { date: today(), amount: advance }, 'Advance applied');
              }}
            >
              <Field label="Amount ₹">
                <Input
                  value={advance}
                  onChange={(e) => setAdvance(e.target.value)}
                  required
                  className="w-36"
                />
              </Field>
              <Button type="submit" variant="secondary">
                Apply
              </Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}

export function NewPaymentRunScreen() {
  const navigate = useNavigate();
  const chart = useChart();
  const projects = useQuery({
    queryKey: ['projects', 'all-for-books'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
  });
  const suppliers = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties'),
  });
  const [bankId, setBankId] = useState('');
  const [payOn, setPayOn] = useState(today());
  const [pay, setPay] = useState<Record<string, string>>({});
  const [advances, setAdvances] = useState<
    { partyId: string; projectId: string; amount: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banks = (chart.data?.accounts ?? []).filter((a) => a.kind === 'bank' && !a.closed);
  return (
    <Books title="New payment run">
      {(entityId) => (
        <RunForm
          entityId={entityId}
          banks={banks}
          bankId={bankId}
          setBankId={setBankId}
          payOn={payOn}
          setPayOn={setPayOn}
          pay={pay}
          setPay={setPay}
          advances={advances}
          setAdvances={setAdvances}
          projects={projects.data?.items ?? []}
          suppliers={(suppliers.data ?? []).filter((p) => p.isVendor || p.isSubcontractor)}
          busy={busy}
          error={error}
          onSubmit={async (lines) => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.request<{ id: string }>('/api/tenant/accounts/payment-runs', {
                method: 'POST',
                body: { entityId, bankAccountId: bankId, payOn, lines },
              });
              toast.success('Payment run made');
              await navigate({ to: '/accounts/payment-runs/$runId', params: { runId: r.id } });
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

function RunForm(p: {
  entityId: string;
  banks: { id: string; code: string; name: string }[];
  bankId: string;
  setBankId: (v: string) => void;
  payOn: string;
  setPayOn: (v: string) => void;
  pay: Record<string, string>;
  setPay: (v: Record<string, string>) => void;
  advances: { partyId: string; projectId: string; amount: string }[];
  setAdvances: (v: { partyId: string; projectId: string; amount: string }[]) => void;
  projects: ProjectSummary[];
  suppliers: Party[];
  busy: boolean;
  error: string | null;
  onSubmit: (lines: object[]) => Promise<void>;
}) {
  const due = useQuery({
    queryKey: ['vendor-bills', p.entityId, 'posted'],
    queryFn: () =>
      api.request<(BillRow & { partyId?: string })[]>(
        `/api/tenant/accounts/vendor-bills?entityId=${p.entityId}&status=posted`,
      ),
  });
  const open = (due.data ?? [])
    .filter((b) => Number(b.outstanding) > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const partyOf = (name: string) => p.suppliers.find((s) => s.name === name)?.id ?? '';
  const total =
    Object.values(p.pay).reduce((s, v) => s + Math.round(Number(v || 0) * 100), 0) +
    p.advances.reduce((s, a) => s + Math.round(Number(a.amount || 0) * 100), 0);
  return (
    <form
      aria-label="Payment run"
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const lines = [
          ...open
            .filter((b) => Number(p.pay[b.id] || 0) > 0)
            .map((b) => ({
              partyId: partyOf(b.party),
              kind: 'bill',
              billId: b.id,
              amount: p.pay[b.id],
            })),
          ...p.advances.filter((a) => Number(a.amount) > 0).map((a) => ({ ...a, kind: 'advance' })),
        ];
        void p.onSubmit(lines);
      }}
    >
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pay from">
            <Select value={p.bankId} onChange={(e) => p.setBankId(e.target.value)} required>
              <option value="">Bank</option>
              {p.banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment date">
            <Input
              type="date"
              value={p.payOn}
              onChange={(e) => p.setPayOn(e.target.value)}
              required
            />
          </Field>
        </div>
      </Card>
      <Card title="Bills to pay">
        {!open.length ? (
          <EmptyState title="No bills are outstanding.">
            Posted suppliers&apos; bills with something left to pay show here; advances can be added
            below.
          </EmptyState>
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Bill</th>
                <th>Due</th>
                <th className="text-right">Outstanding</th>
                <th className="text-right">Pay</th>
              </tr>
            </thead>
            <tbody aria-label="Bills to pay">
              {open.map((b) => (
                <tr key={b.id}>
                  <td className="text-sm">{b.party}</td>
                  <td>{b.billNo}</td>
                  <td className="whitespace-nowrap">{shortDate(b.dueDate)}</td>
                  <td className="text-right tabular-nums">{rupees(b.outstanding)}</td>
                  <td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <Input
                        aria-label={`Pay ${b.party} ${b.billNo}`}
                        className="w-32 text-right"
                        value={p.pay[b.id] ?? ''}
                        onChange={(e) => p.setPay({ ...p.pay, [b.id]: e.target.value })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => p.setPay({ ...p.pay, [b.id]: b.outstanding })}
                      >
                        All
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Advances">
        <div className="space-y-2">
          {p.advances.map((a, i) => (
            <fieldset
              key={i}
              aria-label={`Advance ${i + 1}`}
              className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem_auto]"
            >
              <Select
                aria-label="Supplier"
                value={a.partyId}
                onChange={(e) =>
                  p.setAdvances(
                    p.advances.map((x, j) => (j === i ? { ...x, partyId: e.target.value } : x)),
                  )
                }
              >
                <option value="">Supplier</option>
                {p.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Project"
                value={a.projectId}
                onChange={(e) =>
                  p.setAdvances(
                    p.advances.map((x, j) => (j === i ? { ...x, projectId: e.target.value } : x)),
                  )
                }
              >
                <option value="">Project</option>
                {p.projects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.number} · {x.name}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Amount"
                value={a.amount}
                onChange={(e) =>
                  p.setAdvances(
                    p.advances.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove advance ${i + 1}`}
                onClick={() => p.setAdvances(p.advances.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              p.setAdvances([...p.advances, { partyId: '', projectId: '', amount: '' }])
            }
          >
            <Plus className="size-4" aria-hidden /> An advance
          </Button>
        </div>
      </Card>
      {p.error && <Alert tone="danger">{p.error}</Alert>}
      <div className="flex items-center gap-3">
        <Button type="submit" busy={p.busy} disabled={!total}>
          Make the run
        </Button>
        <span className="text-sm tabular-nums" aria-label="Run total">
          {rupees((total / 100).toFixed(2))}
        </span>
      </div>
    </form>
  );
}

interface Run {
  id: string;
  number: string;
  payOn: string;
  paidOn: string | null;
  status: keyof typeof RUN_TONE;
  statusReason: string | null;
  total: string;
  company: string;
  bank: { code: string; name: string };
  lines: {
    position: number;
    kind: 'bill' | 'advance';
    amount: string;
    party: { id: string; name: string; accountNo: string | null; ifsc: string | null };
    bill: { id: string; billNo: string; billDate: string; total: string; tds: string } | null;
    project: { number: string; name: string } | null;
    voucher: { id: string; number: string } | null;
  }[];
  approval: { id: string } | null;
  maySubmit: boolean;
  mayPay: boolean;
  mayCancel: boolean;
}

export function PaymentRunScreen({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const key = ['payment-run', runId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Run>(`/api/tenant/accounts/payment-runs/${runId}`),
  });
  const [paidOn, setPaidOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const x = r.data;
  const act = (path: string, body: object, said: string) => {
    setError(null);
    void api
      .request<Run>(`/api/tenant/accounts/payment-runs/${x.id}/${path}`, { method: 'POST', body })
      .then((next) => {
        qc.setQueryData(key, next);
        toast.success(said);
        void qc.invalidateQueries({ queryKey: ['payables'] });
      })
      .catch((err: unknown) => setError(describeError(err)));
  };
  const suppliers = [...new Map(x.lines.map((l) => [l.party.id, l.party])).values()];
  return (
    <div className="space-y-5">
      <Link
        to="/accounts/payables"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> Payables
      </Link>
      <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
        Payment run {x.number} <Badge tone={RUN_TONE[x.status]}>{x.status}</Badge>
        <Link
          to="/print/payment-runs/$runId"
          params={{ runId: x.id }}
          className={`ml-auto ${printLink}`}
        >
          Payment advices
        </Link>
      </h1>
      <p className="text-sm text-fg-muted">
        {x.company}: {rupees(x.total)} from {x.bank.code} {x.bank.name},{' '}
        {x.paidOn ? `paid ${shortDate(x.paidOn)}` : `to pay ${shortDate(x.payOn)}`}
      </p>
      {x.status === 'pending' && x.approval && (
        <Alert tone="warning">
          Waiting for approval.{' '}
          <Link
            to="/approvals/$approvalId"
            params={{ approvalId: x.approval.id }}
            className="underline"
          >
            The request
          </Link>
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        {x.maySubmit && (
          <Button
            type="button"
            onClick={() => act('submit', {}, `Payment run ${x.number} put up for approval`)}
          >
            Submit for approval
          </Button>
        )}
        {(x.status === 'approved' || x.status === 'paid') && (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void api
                .download(`/api/tenant/accounts/payment-runs/${x.id}/bank-file`)
                .then(({ blob, fileName }) => saveFile(blob, fileName))
                .catch((err: unknown) => setError(describeError(err)))
            }
          >
            <FileSpreadsheet className="size-4" aria-hidden /> Bank file
          </Button>
        )}
        {x.mayPay && (
          <form
            className="flex items-end gap-2"
            aria-label="Mark paid"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                !(await confirm({
                  title: `Mark payment run ${x.number} paid on ${shortDate(paidOn)}?`,
                  body: `${rupees(x.total)} of payments from ${x.bank.name} are posted to the books and the bills settled. It cannot be undone.`,
                  confirmLabel: 'Mark paid',
                  tone: 'primary',
                }))
              )
                return;
              act('paid', { paidOn }, `Payment run ${x.number} marked paid`);
            }}
          >
            <Field label="Paid on">
              <Input
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                className="w-40"
              />
            </Field>
            <Button type="submit">Mark paid</Button>
          </form>
        )}
        {x.status === 'paid' && (
          <Button type="button" variant="secondary" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Payment advices
          </Button>
        )}
        {x.mayCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              if (
                !(await confirm({
                  title: `Cancel payment run ${x.number}?`,
                  body: 'The run is cancelled for good; its bills are left to pay in another run. You will be asked why.',
                  confirmLabel: 'Cancel the run',
                  tone: 'danger',
                }))
              )
                return;
              const why = window.prompt('Why is the run cancelled?');
              if (why && why.trim().length >= 3)
                act('cancel', { reason: why.trim() }, `Payment run ${x.number} cancelled`);
            }}
          >
            Cancel the run
          </Button>
        )}
      </div>
      {suppliers.map((s) => {
        const mine = x.lines.filter((l) => l.party.id === s.id);
        const sum = mine.reduce((t, l) => t + Number(l.amount), 0);
        return (
          <Card
            key={s.id}
            title={`${s.name}: ${rupees(sum.toFixed(2))}`}
            className="break-inside-avoid"
          >
            <p className="mb-2 text-xs text-fg-muted">
              {s.accountNo ? `A/c ${s.accountNo}, IFSC ${s.ifsc}` : 'No bank account on record'}
              {mine[0]?.voucher && ` · ${mine[0].voucher.number}`}
            </p>
            <Table minWidth="30rem">
              <tbody aria-label={`Paid to ${s.name}`}>
                {mine.map((l) => (
                  <tr key={l.position}>
                    <td>
                      {l.bill ? (
                        <Link
                          to="/accounts/vendor-bills/$billId"
                          params={{ billId: l.bill.id }}
                          className="text-accent hover:underline"
                        >
                          Bill {l.bill.billNo} of {shortDate(l.bill.billDate)}
                        </Link>
                      ) : (
                        `Advance${l.project ? `, ${l.project.number}` : ''}`
                      )}
                      {l.bill && Number(l.bill.tds) > 0 && (
                        <span className="text-xs text-fg-muted">
                          {' '}
                          (TDS {rupees(l.bill.tds)} deducted)
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{rupees(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        );
      })}
    </div>
  );
}

/** The rate tolerance: a bill priced above its order by more than this is held for someone to pass. */
function Tolerance() {
  const qc = useQueryClient();
  const s = useQuery({
    queryKey: ['payables-settings'],
    queryFn: () =>
      api.request<{ rateTolerancePct: string; mayEdit: boolean }>(
        '/api/tenant/accounts/payables-settings',
      ),
  });
  const [pct, setPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!s.data) return null;
  const value = pct ?? s.data.rateTolerancePct;
  return (
    <Card title="Rate tolerance">
      <form
        aria-label="Rate tolerance"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request('/api/tenant/accounts/payables-settings', {
              method: 'POST',
              body: { rateTolerancePct: value },
            })
            .then(() => {
              toast.success('Rate tolerance saved');
              setPct(null);
              void qc.invalidateQueries({ queryKey: ['payables-settings'] });
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <Field label="Bills may exceed the order rate by (%)">
          <Input
            inputMode="decimal"
            value={value}
            onChange={(e) => setPct(e.target.value)}
            disabled={!s.data.mayEdit}
            className="w-32"
          />
        </Field>
        {s.data.mayEdit && (
          <Button type="submit" variant="secondary" disabled={pct === null}>
            Save
          </Button>
        )}
      </form>
      <p className="mt-2 text-xs text-fg-muted">
        Above it, a supplier&rsquo;s bill is held, with no voucher, until someone passes it.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
