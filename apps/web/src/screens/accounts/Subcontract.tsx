// Subcontract bills (docs/wave3-plan.md step 5): on a work order, its terms, measurement book (entries reversed, never
// changed), RA bills and retention released; and the RA bill itself, with this bill's quantities, back-charges and the
// deductions worked out, submitted under the approval rules and certified into payables.
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
  cx,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { ledgerOptions, today, useChart } from '../../accounts/model';
import { formatQty } from '../../boq/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { FreeIssueBill, FreeIssueOrder } from './FreeIssue';

const n = (v: string | null | undefined) => Number(v ?? 0);
const q = (v: number) => formatQty(String(Math.round(v * 10000) / 10000));

interface Terms {
  retentionPct: string;
  retentionCap: string | null;
  advanceRecoveryPct: string;
  labourCessPct: string;
  tdsSection: string | null;
}
interface WorkOrder {
  order: {
    id: string;
    number: string;
    status: string;
    supply: string;
    party: { id: string; name: string };
    project: { id: string; number: string; name: string };
  };
  terms: Terms;
  lines: {
    lineKey: string;
    description: string;
    unit: string;
    qty: string;
    rate: string;
    measured: string;
    certified: string;
  }[];
  book: {
    id: string;
    lineKey: string;
    measuredOn: string;
    qty: string;
    description: string;
    reverses: string | null;
    reversed: boolean;
    by: string | null;
  }[];
  bills: {
    id: string;
    raNo: number;
    upto: string;
    status: Status;
    net: string | null;
    gross: string | null;
    billNo: string | null;
    vendorBillId: string | null;
  }[];
  releases: { id: string; billNo: string; date: string; amount: string }[];
  retention: { held: string; released: string; left: string };
  mayMeasure: boolean;
  mayBill: boolean;
  mayRelease: boolean;
}
type Status = 'draft' | 'pending' | 'certified' | 'cancelled';
const STATUS: Record<Status, string> = {
  draft: 'Draft',
  pending: 'Waiting for approval',
  certified: 'Certified',
  cancelled: 'Cancelled',
};
const TONE: Record<Status, 'neutral' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  pending: 'warning',
  certified: 'success',
  cancelled: 'danger',
};
interface Figures {
  gross: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  retention: string;
  advance: string;
  backcharges: string;
  cess: string;
  tdsSection: string | null;
  tdsRate: string;
  tdsBase: string;
  tds: string;
  payable: string;
  net: string;
}
interface ScBill {
  id: string;
  raNo: number;
  upto: string;
  status: Status;
  statusReason: string | null;
  terms: Terms;
  certified: Figures | null;
  figures: Figures | null;
  problem: string | null;
  /** A labour contractor's months not yet verified as paid (step 13). */
  unverifiedWages?: { month: string; site: string; status: string }[];
  rowVersion: number;
  vendorBill: { id: string; billNo: string; voucher: string | null } | null;
  project: { id: string; number: string; name: string };
  order: { id: string; number: string; supply: string; party: { id: string; name: string } };
  lines: {
    lineKey: string;
    description: string;
    unit: string;
    rate: string;
    gstPct: string;
    prevQty: string;
    measuredQty: string;
    cumQty: string;
  }[];
  backcharges: { description: string; amount: string; accountId: string; account: string }[];
  approval: { id: string } | null;
  mayEdit: boolean;
  maySubmit: boolean;
  mayCancel: boolean;
}

/** The subcontract side of a work order, shown on the order's page. */
export function WorkOrderSubcontract({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const key = ['work-order-subcontract', orderId];
  const w = useQuery({
    queryKey: key,
    queryFn: () => api.request<WorkOrder>(`/api/tenant/work-orders/${orderId}/subcontract`),
  });
  if (w.isPending) return <Spinner />;
  if (w.isError) return null;
  return <WorkOrderView w={w.data} onChanged={(next) => qc.setQueryData(key, next)} />;
}

function WorkOrderView({ w, onChanged }: { w: WorkOrder; onChanged: (w: WorkOrder) => void }) {
  const navigate = useNavigate();
  const [terms, setTerms] = useState(w.terms);
  const [entry, setEntry] = useState({
    lineKey: w.lines[0]?.lineKey ?? '',
    measuredOn: today(),
    qty: '',
    description: '',
  });
  const [upto, setUpto] = useState(today());
  const [release, setRelease] = useState({ date: today(), amount: w.retention.left });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/tenant/work-orders/${w.order.id}`;
  const act = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const call = (k: string, path: string, body: object, method = 'POST') =>
    act(k, async () => onChanged(await api.request<WorkOrder>(path, { method, body })));
  const lineName = (k: string) => w.lines.find((l) => l.lineKey === k)?.description ?? '';

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Subcontract terms" className="print:hidden">
        <form
          aria-label="Subcontract terms"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void call(
              'terms',
              `${base}/subcontract-terms`,
              {
                ...terms,
                retentionCap: terms.retentionCap || null,
                tdsSection: terms.tdsSection || null,
              },
              'PUT',
            );
          }}
        >
          <Field label="Retention %">
            <Input
              className="w-24"
              value={terms.retentionPct}
              disabled={!w.mayMeasure}
              onChange={(e) => setTerms({ ...terms, retentionPct: e.target.value })}
            />
          </Field>
          <Field label="Retention cap ₹">
            <Input
              className="w-32"
              value={terms.retentionCap ?? ''}
              disabled={!w.mayMeasure}
              onChange={(e) => setTerms({ ...terms, retentionCap: e.target.value })}
            />
          </Field>
          <Field label="Advance recovery %">
            <Input
              className="w-24"
              value={terms.advanceRecoveryPct}
              disabled={!w.mayMeasure}
              onChange={(e) => setTerms({ ...terms, advanceRecoveryPct: e.target.value })}
            />
          </Field>
          <Field label="Labour cess %">
            <Input
              className="w-24"
              value={terms.labourCessPct}
              disabled={!w.mayMeasure}
              onChange={(e) => setTerms({ ...terms, labourCessPct: e.target.value })}
            />
          </Field>
          <Field label="TDS section">
            <Select
              value={terms.tdsSection ?? ''}
              disabled={!w.mayMeasure}
              onChange={(e) => setTerms({ ...terms, tdsSection: e.target.value })}
            >
              <option value="194C">194C contractors</option>
              <option value="194J">194J professionals</option>
              <option value="">None</option>
            </Select>
          </Field>
          {w.mayMeasure && (
            <Button type="submit" variant="secondary" busy={busy === 'terms'}>
              Save terms
            </Button>
          )}
        </form>
      </Card>
      <FreeIssueOrder orderId={w.order.id} mayEdit={w.mayBill} />
      <Card title="Measurement book" className="print:hidden">
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Ordered</th>
              <th className="text-right">Measured</th>
              <th className="text-right">Certified</th>
            </tr>
          </thead>
          <tbody aria-label="Work order quantities">
            {w.lines.map((l) => (
              <tr key={l.lineKey}>
                <td>
                  {l.description} <span className="text-xs text-fg-muted">{l.unit}</span>
                </td>
                <td className="text-right tabular-nums">{q(n(l.qty))}</td>
                <td className="text-right tabular-nums">{q(n(l.measured))}</td>
                <td className="text-right tabular-nums">{q(n(l.certified))}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {w.mayMeasure && (
          <form
            aria-label="Measure"
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void call('measure', `${base}/measurements`, entry).then(() =>
                setEntry((x) => ({ ...x, qty: '', description: '' })),
              );
            }}
          >
            <Field label="Item">
              <Select
                value={entry.lineKey}
                onChange={(e) => setEntry({ ...entry, lineKey: e.target.value })}
              >
                {w.lines.map((l) => (
                  <option key={l.lineKey} value={l.lineKey}>
                    {l.description}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Measured on">
              <Input
                type="date"
                className="w-40"
                max={today()}
                value={entry.measuredOn}
                onChange={(e) => setEntry({ ...entry, measuredOn: e.target.value })}
                required
              />
            </Field>
            <Field label="Quantity">
              <Input
                className="w-28 text-right"
                value={entry.qty}
                onChange={(e) => setEntry({ ...entry, qty: e.target.value })}
                required
              />
            </Field>
            <Field label="Where, what">
              <Input
                value={entry.description}
                maxLength={500}
                onChange={(e) => setEntry({ ...entry, description: e.target.value })}
              />
            </Field>
            <Button type="submit" busy={busy === 'measure'}>
              Record
            </Button>
          </form>
        )}
        {w.book.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm" aria-label="Book entries">
            {w.book.map((e) => (
              <li key={e.id} className={cx(e.reversed && 'text-fg-muted line-through')}>
                {shortDate(e.measuredOn)}: {lineName(e.lineKey)} {q(n(e.qty))}
                {e.description && ` (${e.description})`}
                {e.by && <span className="text-xs text-fg-muted"> by {e.by}</span>}
                {w.mayMeasure && !e.reversed && !e.reverses && (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Reverse the entry of ${shortDate(e.measuredOn)} for ${lineName(e.lineKey)}`}
                    onClick={() => {
                      const reason = window.prompt('Why is the entry reversed?');
                      if (reason && reason.trim().length >= 3)
                        void call('reverse', `/api/tenant/wo-measurements/${e.id}/reverse`, {
                          date: today(),
                          reason: reason.trim(),
                        });
                    }}
                  >
                    <Undo2 className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Subcontract bills" className="print:hidden">
        {w.bills.length > 0 ? (
          <Table minWidth="36rem">
            <thead>
              <tr>
                <th>RA</th>
                <th>Up to</th>
                <th>Status</th>
                <th className="text-right">Gross</th>
                <th className="text-right">To pay</th>
              </tr>
            </thead>
            <tbody aria-label="Subcontract bills">
              {w.bills.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link
                      to="/subcontract-bills/$billId"
                      params={{ billId: b.id }}
                      className="text-accent hover:underline"
                    >
                      RA {b.raNo}
                    </Link>
                  </td>
                  <td>{shortDate(b.upto)}</td>
                  <td>
                    <Badge tone={TONE[b.status]}>{STATUS[b.status]}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{b.gross ? rupees(b.gross) : '-'}</td>
                  <td className="text-right tabular-nums">{b.net ? rupees(b.net) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-fg-muted">No bills yet.</p>
        )}
        {w.mayBill && (
          <form
            aria-label="New subcontract bill"
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act('bill', async () => {
                const b = await api.request<ScBill>(`${base}/subcontract-bills`, {
                  method: 'POST',
                  body: { upto },
                });
                await navigate({ to: '/subcontract-bills/$billId', params: { billId: b.id } });
              });
            }}
          >
            <Field label="Measured up to">
              <Input
                type="date"
                className="w-40"
                value={upto}
                onChange={(e) => setUpto(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" busy={busy === 'bill'}>
              <Plus className="size-4" aria-hidden /> New RA bill
            </Button>
          </form>
        )}
        <p className="mt-4 text-sm" aria-label="Retention">
          Retention held {rupees(w.retention.held)}, released {rupees(w.retention.released)}
          {n(w.retention.left) > 0 && `, ${rupees(w.retention.left)} still held`}.
        </p>
        {w.releases.length > 0 && (
          <ul className="mt-1 space-y-1 text-sm">
            {w.releases.map((r) => (
              <li key={r.id}>
                <Link
                  to="/accounts/vendor-bills/$billId"
                  params={{ billId: r.id }}
                  className="font-mono text-accent hover:underline"
                >
                  {r.billNo}
                </Link>{' '}
                {shortDate(r.date)}: {rupees(r.amount)}
              </li>
            ))}
          </ul>
        )}
        {w.mayRelease && (
          <form
            aria-label="Release retention"
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void call('release', `${base}/retention-release`, release);
            }}
          >
            <Field label="Released on">
              <Input
                type="date"
                className="w-40"
                value={release.date}
                onChange={(e) => setRelease({ ...release, date: e.target.value })}
                required
              />
            </Field>
            <Field label="Amount">
              <Input
                className="w-32 text-right"
                value={release.amount}
                onChange={(e) => setRelease({ ...release, amount: e.target.value })}
                required
              />
            </Field>
            <Button type="submit" variant="secondary" busy={busy === 'release'}>
              Release retention
            </Button>
          </form>
        )}
      </Card>
    </>
  );
}

export function SubcontractBillScreen({ billId }: { billId: string }) {
  const qc = useQueryClient();
  const key = ['subcontract-bill', billId];
  const b = useQuery({
    queryKey: key,
    queryFn: () => api.request<ScBill>(`/api/tenant/subcontract-bills/${billId}`),
  });
  if (b.isPending) return <Spinner />;
  if (b.isError) return <Alert tone="danger">{describeError(b.error)}</Alert>;
  return (
    <BillView
      key={b.data.rowVersion}
      b={b.data}
      onChanged={(next) => {
        qc.setQueryData(key, next);
        void qc.invalidateQueries({ queryKey: ['work-order-subcontract', next.order.id] });
      }}
    />
  );
}

function BillView({ b, onChanged }: { b: ScBill; onChanged: (next: ScBill) => void }) {
  const [cum, setCum] = useState<Record<string, string>>(() =>
    Object.fromEntries(b.lines.map((l) => [l.lineKey, l.cumQty])),
  );
  const initial = b.backcharges.map((c) => ({
    description: c.description,
    amount: c.amount,
    accountId: c.accountId,
  }));
  const [charges, setCharges] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chart = useChart({ ifAllowed: true });
  const run = async (k: string, path: string, body: object, method = 'POST') => {
    setBusy(k);
    setError(null);
    try {
      onChanged(
        await api.request<ScBill>(`/api/tenant/subcontract-bills/${b.id}${path}`, { method, body }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const dirty =
    b.mayEdit &&
    (b.lines.some((l) => cum[l.lineKey] !== l.cumQty) ||
      JSON.stringify(charges) !== JSON.stringify(initial));
  const f = b.certified ?? b.figures;
  const row = (label: string, v: string | undefined, strong = false, show = n(v) !== 0) =>
    show && (
      <tr className={cx(strong && 'font-semibold')}>
        <td>{label}</td>
        <td className="text-right tabular-nums">{rupees(v ?? '0')}</td>
      </tr>
    );

  return (
    <div className="space-y-5">
      <Link
        to="/orders/$orderId"
        params={{ orderId: b.order.id }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> {b.order.number} · {b.order.party.name}
      </Link>
      <PageHeader
        title={`Subcontract RA bill ${b.raNo}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[b.status]}>{STATUS[b.status]}</Badge>
            <span>Measured up to {shortDate(b.upto)}</span>
            <span>
              {b.project.number} · {b.project.name}
            </span>
          </span>
        }
        actions={
          b.mayCancel && (
            <Button
              type="button"
              variant="ghost"
              busy={busy === 'cancel'}
              onClick={() => {
                const reason = window.prompt('Why is the bill cancelled?');
                if (reason && reason.trim().length >= 3)
                  void run('cancel', '/cancel', { reason: reason.trim() });
              }}
            >
              Cancel bill
            </Button>
          )
        }
      />
      {b.statusReason && (
        <Alert tone={b.status === 'cancelled' ? 'info' : 'warning'}>
          {b.status === 'cancelled' ? 'Cancelled' : 'Sent back'}: {b.statusReason}
        </Alert>
      )}
      {b.status === 'pending' && (
        <Alert tone="warning">
          Waiting for approval.{' '}
          {b.approval && (
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: b.approval.id }}
              className="underline"
            >
              The request
            </Link>
          )}
        </Alert>
      )}
      {b.problem && <Alert tone="warning">{b.problem}</Alert>}
      {(b.unverifiedWages?.length ?? 0) > 0 && (
        <Alert tone="warning">
          Wages not verified as paid:{' '}
          {b.unverifiedWages!.map((x) => `${x.month} at ${x.site} (${x.status})`).join('; ')}. Check
          before certifying.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Items">
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Previous</th>
              <th className="text-right">To date</th>
              <th className="text-right">This bill</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody aria-label="Bill items">
            {b.lines.map((l) => {
              const c = b.mayEdit ? n(cum[l.lineKey]) : n(l.cumQty);
              const thisQty = c - n(l.prevQty);
              return (
                <tr key={l.lineKey}>
                  <td>
                    {l.description} <span className="text-xs text-fg-muted">{l.unit}</span>
                    {n(l.measuredQty) !== c && (
                      <div className="text-xs text-fg-muted">
                        Measured to date {q(n(l.measuredQty))}
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{rupees(l.rate)}</td>
                  <td className="text-right tabular-nums">{q(n(l.prevQty))}</td>
                  <td className="text-right tabular-nums">
                    {b.mayEdit ? (
                      <Input
                        aria-label={`To date ${l.description}`}
                        className="ml-auto w-24 text-right"
                        value={cum[l.lineKey]}
                        onChange={(e) => setCum({ ...cum, [l.lineKey]: e.target.value })}
                      />
                    ) : (
                      q(n(l.cumQty))
                    )}
                  </td>
                  <td className="text-right tabular-nums">{q(thisQty)}</td>
                  <td className="text-right tabular-nums">
                    {rupees((Math.round(thisQty * n(l.rate) * 100) / 100).toFixed(2))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
      <FreeIssueBill
        billId={b.id}
        mayRecover={b.mayEdit}
        onRecovered={() =>
          void api.request<ScBill>(`/api/tenant/subcontract-bills/${b.id}`).then(onChanged)
        }
      />
      {b.mayEdit && (
        <Card title="Back-charges">
          <div className="space-y-2">
            {charges.map((d, i) => (
              <fieldset
                key={i}
                aria-label={`Back-charge ${i + 1}`}
                className="grid gap-2 sm:grid-cols-[1fr_9rem_16rem_auto]"
              >
                <Input
                  aria-label="What"
                  placeholder="Cement issued from stores"
                  value={d.description}
                  onChange={(e) =>
                    setCharges(
                      charges.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  aria-label="Amount"
                  className="text-right"
                  value={d.amount}
                  onChange={(e) =>
                    setCharges(
                      charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                />
                <Select
                  aria-label="Ledger"
                  value={d.accountId}
                  onChange={(e) =>
                    setCharges(
                      charges.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">Recovers which cost?</option>
                  {ledgerOptions(
                    (chart.data?.accounts ?? []).filter((a) =>
                      ['ordinary', 'tax'].includes(a.kind),
                    ),
                  ).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove back-charge ${i + 1}`}
                  onClick={() => setCharges(charges.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setCharges([...charges, { description: '', amount: '', accountId: '' }])
              }
            >
              <Plus className="size-4" aria-hidden /> Add a back-charge
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              busy={busy === 'save'}
              disabled={!dirty}
              onClick={() =>
                void run(
                  'save',
                  '',
                  {
                    rowVersion: b.rowVersion,
                    lines: b.lines
                      .filter((l) => cum[l.lineKey] !== l.cumQty)
                      .map((l) => ({ lineKey: l.lineKey, cumQty: cum[l.lineKey] })),
                    backcharges: charges,
                  },
                  'PUT',
                )
              }
            >
              Save and work out
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={busy === 'refresh'}
              onClick={() => {
                if (
                  window.confirm(
                    'Take the measurement book again? Quantities typed in here are lost.',
                  )
                )
                  void run('refresh', '/refresh', { upto: b.upto, rowVersion: b.rowVersion });
              }}
            >
              Take the book again
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={busy === 'submit'}
              disabled={dirty || !b.maySubmit}
              onClick={() => void run('submit', '/submit', { rowVersion: b.rowVersion })}
            >
              Submit for certification
            </Button>
          </div>
        </Card>
      )}
      {f && (
        <Card title={b.certified ? 'Abstract, as certified' : 'Abstract'}>
          <Table minWidth="24rem">
            <tbody aria-label="Abstract">
              {row('Value of work done this bill', f.gross, true, true)}
              {row('CGST', f.cgst)}
              {row('SGST', f.sgst)}
              {row('IGST', f.igst)}
              {row('Bill total', f.total, true, true)}
              {row(`Less: TDS ${f.tdsSection ?? ''} at ${f.tdsRate}%`, f.tds)}
              {row(`Less: retention ${b.terms.retentionPct}%`, f.retention)}
              {row('Less: back-charges', f.backcharges)}
              {row(`Less: labour cess ${b.terms.labourCessPct}%`, f.cess)}
              {row('Less: advance recovered', f.advance)}
              {row('Net to pay', f.net, true, true)}
            </tbody>
          </Table>
          {b.vendorBill && (
            <p className="mt-3 text-sm">
              In payables as{' '}
              <Link
                to="/accounts/vendor-bills/$billId"
                params={{ billId: b.vendorBill.id }}
                className="font-mono text-accent hover:underline"
              >
                {b.vendorBill.billNo}
              </Link>
              {b.vendorBill.voucher && <>, voucher {b.vendorBill.voucher}</>}.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
