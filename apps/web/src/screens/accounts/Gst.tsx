// GST (docs/wave3-plan.md step 6a): the month's outward and inward registers, GSTR-1 in the offline tool's sheets,
// the GSTR-3B summary and the supplier-filed GSTR-2B matched against the purchase book; and, on a client bill, its
// credit notes and e-invoice (the IRP JSON out, the IRN and signed QR back).
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Spinner,
  Table,
  cx,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileJson, FileSpreadsheet, Upload } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { usePermission } from '../../session/permissions';
import { api, saveFile } from '../../api/client';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { rupees } from '../../procurement/OrderLines';
import { shortDate } from '../../schedule/model';
import { Books } from './Vouchers';

const lastMonth = () => {
  const d = today();
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const monthEnd = (p: string) => {
  const [y, m] = [Number(p.slice(0, 4)), Number(p.slice(5, 7))];
  return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const neg = (kind: string, v: string) =>
  kind === 'credit_note' || kind === 'debit_note' ? `−${rupees(v)}` : rupees(v);

interface Registers {
  outward: {
    kind: 'invoice' | 'credit_note';
    id: string;
    billId: string;
    number: string;
    date: string;
    party: string;
    gstin: string | null;
    pos: string | null;
    rate: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
  }[];
  inward: {
    kind: 'bill' | 'debit_note';
    id: string;
    billId: string;
    party: string;
    gstin: string | null;
    billNo: string;
    date: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
    blocked: string;
  }[];
  outwardTotals: Record<'taxable' | 'cgst' | 'sgst' | 'igst' | 'total', string>;
  inwardTotals: Record<'taxable' | 'cgst' | 'sgst' | 'igst' | 'total' | 'blocked', string>;
}
type Heads = Record<'igst' | 'cgst' | 'sgst' | 'cess', string>;
interface Gstr3b {
  outward: Heads & { taxable: string };
  inwardReverseCharge: Heads & { taxable: string };
  itcAll: Heads;
  itcReverseCharge: Heads;
  itcBlocked: Heads;
  itcReversedRule37: Heads;
  itcReclaimed: Heads;
  itcNet: Heads;
  payableInCash: Heads;
}
interface Recon {
  upload: { fileName: string; uploadedAt: string } | null;
  rows: {
    status: 'matched' | 'differs' | 'in_2b_only' | 'in_books_only';
    gstin: string;
    party: string;
    number: string;
    date: string;
    taxable2b: string | null;
    tax2b: string | null;
    taxableBooks: string | null;
    taxBooks: string | null;
    billId: string | null;
  }[];
  counts: { matched: number; differs: number; in2bOnly: number; inBooksOnly: number } | null;
}
const RECON: Record<
  Recon['rows'][number]['status'],
  [string, 'success' | 'warning' | 'danger' | 'neutral']
> = {
  matched: ['Matched', 'success'],
  differs: ['Differs', 'warning'],
  in_2b_only: ['In 2B only', 'neutral'],
  in_books_only: ['Not filed by the supplier', 'danger'],
};

export function GstScreen() {
  const [period, setPeriod] = useState(lastMonth());
  return (
    <Books title="GST">
      {(entityId) => (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Month">
              <Input
                type="month"
                value={period}
                onChange={(e) => e.target.value && setPeriod(e.target.value)}
                className="w-44"
              />
            </Field>
          </div>
          <Returns entityId={entityId} period={period} />
          <RegistersCard entityId={entityId} period={period} />
          <TwoB entityId={entityId} period={period} />
          <Rule37 entityId={entityId} />
          <GstTds entityId={entityId} period={period} />
        </>
      )}
    </Books>
  );
}

function Returns({ entityId, period }: { entityId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const b = useQuery({
    queryKey: ['gstr3b', entityId, period],
    queryFn: () =>
      api.request<Gstr3b>(`/api/tenant/accounts/gst/gstr3b?entityId=${entityId}&period=${period}`),
  });
  const download = () =>
    void api
      .download(`/api/tenant/accounts/gst/gstr1?entityId=${entityId}&period=${period}&format=xlsx`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  const row = (label: string, h: Heads & { taxable?: string }, strong = false) => (
    <tr className={cx(strong && 'font-semibold')}>
      <td>{label}</td>
      <td className="text-right tabular-nums">
        {h.taxable !== undefined ? rupees(h.taxable) : ''}
      </td>
      <td className="text-right tabular-nums">{rupees(h.igst)}</td>
      <td className="text-right tabular-nums">{rupees(h.cgst)}</td>
      <td className="text-right tabular-nums">{rupees(h.sgst)}</td>
    </tr>
  );
  return (
    <Card
      title="Returns"
      actions={
        <Button type="button" variant="secondary" onClick={download}>
          <FileSpreadsheet className="size-4" aria-hidden /> GSTR-1 for the offline tool
        </Button>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {b.isPending ? (
        <Spinner />
      ) : b.isError ? (
        <Alert tone="danger">{describeError(b.error)}</Alert>
      ) : (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>GSTR-3B</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">IGST</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
            </tr>
          </thead>
          <tbody aria-label="GSTR-3B">
            {row('3.1(a) Outward taxable supplies', b.data.outward)}
            {row('3.1(d) Inward supplies under reverse charge', b.data.inwardReverseCharge)}
            {row('4(A)(3) Input tax on reverse charge', b.data.itcReverseCharge)}
            {row('4(A)(5) Input tax, all other', b.data.itcAll)}
            {row('4(B)(1) Reversed: section 17(5)', b.data.itcBlocked)}
            {row('4(B)(2) Reversed: Rule 37, suppliers unpaid', b.data.itcReversedRule37)}
            {row('4(D)(1) Re-claimed on payment', b.data.itcReclaimed)}
            {row('4(C) Net input tax available', b.data.itcNet, true)}
            {row('Reverse-charge tax, paid in cash', b.data.payableInCash, true)}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface Rule37Row {
  billId: string;
  billNo: string;
  billDate: string;
  party: string;
  unpaid: string;
  cgst: string;
  sgst: string;
  igst: string;
}
interface Rule37View {
  due: Rule37Row[];
  reversed: (Rule37Row & { reversedOn: string; outstanding: string })[];
  toReclaim: (Rule37Row & { reclaim: Record<'cgst' | 'sgst' | 'igst', string> })[];
  mayPost: boolean;
}

/** Rule 37 (docs/wave8-plan.md step 8b.1): credit on bills unpaid after 180 days, and its return on payment. */
function Rule37({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const [asOf, setAsOf] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const key = ['itc-reversals', entityId, asOf];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Rule37View>(
        `/api/tenant/accounts/itc-reversals?entityId=${entityId}&asOf=${asOf}`,
      ),
  });
  const run = async () => {
    if (
      !(await confirm({
        title: `Post the Rule 37 reversals and re-claims as on ${shortDate(asOf)}?`,
        body: 'Input tax on suppliers unpaid after 180 days is reversed, and tax on those since paid is taken back, by vouchers posted to the books.',
        confirmLabel: 'Post reversals and re-claims',
        tone: 'primary',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Rule37View>('/api/tenant/accounts/itc-reversals', {
          method: 'POST',
          body: { entityId, asOf },
        }),
      );
      toast.success('Rule 37 reversals and re-claims posted');
      await qc.invalidateQueries({ queryKey: ['gstr3b'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const tax = (r: Record<'cgst' | 'sgst' | 'igst', string>) =>
    rupees(String(Number(r.cgst) + Number(r.sgst) + Number(r.igst)));
  const rows = q.data
    ? [
        ...q.data.due.map((r) => ({ ...r, state: 'Reverse now', amount: tax(r) })),
        ...q.data.toReclaim.map((r) => ({
          ...r,
          state: 'Paid: take back',
          amount: tax(r.reclaim),
        })),
        ...q.data.reversed.map((r) => ({
          ...r,
          state: `Reversed ${shortDate(r.reversedOn)}`,
          amount: tax(r),
        })),
      ]
    : [];
  return (
    <Card
      title="Credit on suppliers unpaid after 180 days (Rule 37)"
      actions={
        <div className="flex items-end gap-2">
          <Input
            type="date"
            aria-label="As on"
            value={asOf}
            onChange={(e) => e.target.value && setAsOf(e.target.value)}
            className="w-40"
          />
          {q.data?.mayPost && (q.data.due.length || q.data.toReclaim.length) ? (
            <Button type="button" busy={busy} onClick={() => void run()}>
              Post reversals and re-claims
            </Button>
          ) : null}
        </div>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No bill has gone 180 days unpaid.">
          Suppliers&apos; bills unpaid 180 days after their date show here, with the input tax to
          reverse.
        </EmptyState>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Supplier and bill</th>
              <th>Dated</th>
              <th className="text-right">Unpaid</th>
              <th className="text-right">Input tax</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody aria-label="Rule 37">
            {rows.map((r) => (
              <tr key={`${r.billId}-${r.state}`}>
                <td>
                  {r.party}{' '}
                  <Link
                    to="/accounts/vendor-bills/$billId"
                    params={{ billId: r.billId }}
                    className="text-xs hover:underline"
                  >
                    {r.billNo}
                  </Link>
                </td>
                <td>{shortDate(r.billDate)}</td>
                <td className="text-right tabular-nums">{rupees(r.unpaid)}</td>
                <td className="text-right tabular-nums">{r.amount}</td>
                <td>
                  <Badge tone={r.state.startsWith('Reverse now') ? 'warning' : 'neutral'}>
                    {r.state}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface GstTdsView {
  rows: {
    partyId: string;
    party: string;
    month: string;
    receipts: number;
    books: string;
    credit: { amount: string; deductorGstin: string; acceptedOn: string } | null;
    state: 'matched' | 'differs' | 'awaiting';
  }[];
  mayPost: boolean;
}

/** GST TDS by government clients (docs/wave8-plan.md step 8b.2): the receipts against GSTR-7A. */
function GstTds({ entityId, period }: { entityId: string; period: string }) {
  const qc = useQueryClient();
  const q = `entityId=${entityId}&from=${period}-01&to=${monthEnd(period)}`;
  const key = ['gst-tds', entityId, period];
  const v = useQuery({
    queryKey: key,
    queryFn: () => api.request<GstTdsView>(`/api/tenant/accounts/gst-tds?${q}`),
  });
  const [form, setForm] = useState<{
    partyId: string;
    gstin: string;
    amount: string;
    on: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accept = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      await api.request('/api/tenant/accounts/gst-tds/credits', {
        method: 'POST',
        body: {
          entityId,
          partyId: form.partyId,
          month: period,
          deductorGstin: form.gstin,
          amount: form.amount.replace(/,/g, ''),
          acceptedOn: form.on,
        },
      });
      setForm(null);
      toast.success('GST TDS credit accepted');
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (v.isPending) return <Spinner />;
  if (v.isError) return <Alert tone="danger">{describeError(v.error)}</Alert>;
  if (!v.data.rows.length) return null;
  return (
    <Card title="GST TDS by government clients (GSTR-7A)">
      {error && <Alert tone="danger">{error}</Alert>}
      <Table minWidth="36rem">
        <thead>
          <tr>
            <th>Client</th>
            <th className="text-right">In our receipts</th>
            <th className="text-right">In GSTR-7A</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody aria-label="GST TDS">
          {v.data.rows.map((r) => (
            <tr key={`${r.partyId}-${r.month}`}>
              <td>{r.party}</td>
              <td className="text-right tabular-nums">{rupees(r.books)}</td>
              <td className="text-right tabular-nums">
                {r.credit ? rupees(r.credit.amount) : '—'}
                {r.credit && (
                  <div className="text-xs text-fg-muted">
                    {r.credit.deductorGstin}, accepted {shortDate(r.credit.acceptedOn)}
                  </div>
                )}
              </td>
              <td>
                <Badge
                  tone={
                    r.state === 'matched' ? 'success' : r.state === 'differs' ? 'danger' : 'warning'
                  }
                >
                  {r.state === 'matched'
                    ? 'Matched'
                    : r.state === 'differs'
                      ? 'Differs'
                      : 'Awaiting 7A'}
                </Badge>
              </td>
              <td className="text-right">
                {v.data.mayPost && !r.credit ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setForm({ partyId: r.partyId, gstin: '', amount: r.books, on: today() })
                    }
                  >
                    Accept credit
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {form && (
        <form
          onSubmit={(e) => void accept(e)}
          className="mt-3 flex flex-wrap items-end gap-3"
          aria-label="GSTR-7A credit"
        >
          <Field label="Deductor's GSTIN">
            <Input
              value={form.gstin}
              onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
              maxLength={15}
              required
            />
          </Field>
          <Field label="Credit ₹">
            <Input
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              inputMode="decimal"
              required
            />
          </Field>
          <Field label="Accepted on">
            <Input
              type="date"
              value={form.on}
              onChange={(e) => setForm({ ...form, on: e.target.value })}
              required
            />
          </Field>
          <Button type="submit">Take into the cash ledger</Button>
          <Button type="button" variant="ghost" onClick={() => setForm(null)}>
            Cancel
          </Button>
        </form>
      )}
    </Card>
  );
}

function RegistersCard({ entityId, period }: { entityId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const q = `entityId=${entityId}&from=${period}-01&to=${monthEnd(period)}`;
  const r = useQuery({
    queryKey: ['gst-registers', entityId, period],
    queryFn: () => api.request<Registers>(`/api/tenant/accounts/gst/registers?${q}`),
  });
  const excel = () =>
    void api
      .download(`/api/tenant/accounts/gst/registers?${q}&format=xlsx`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  return (
    <>
      <Card
        title="Outward register"
        actions={
          <Button type="button" variant="secondary" onClick={excel}>
            <FileSpreadsheet className="size-4" aria-hidden /> Excel
          </Button>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {d.outward.length === 0 ? (
          <EmptyState title="No invoices this month.">
            Tax invoices appear here when the client certifies an RA bill.
          </EmptyState>
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Client</th>
                <th>Place</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">CGST</th>
                <th className="text-right">SGST</th>
                <th className="text-right">IGST</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody aria-label="Outward register">
              {d.outward.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link
                      to="/client-bills/$billId"
                      params={{ billId: o.billId }}
                      className="font-mono text-accent hover:underline"
                    >
                      {o.number}
                    </Link>
                  </td>
                  <td>{shortDate(o.date)}</td>
                  <td>
                    {o.party}
                    {o.gstin && <div className="font-mono text-xs text-fg-muted">{o.gstin}</div>}
                  </td>
                  <td>{o.pos}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.taxable)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.cgst)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.sgst)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.igst)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.total)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={4}>Total</td>
                <td className="text-right tabular-nums">{rupees(d.outwardTotals.taxable)}</td>
                <td className="text-right tabular-nums">{rupees(d.outwardTotals.cgst)}</td>
                <td className="text-right tabular-nums">{rupees(d.outwardTotals.sgst)}</td>
                <td className="text-right tabular-nums">{rupees(d.outwardTotals.igst)}</td>
                <td className="text-right tabular-nums">{rupees(d.outwardTotals.total)}</td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Inward register">
        {d.inward.length === 0 ? (
          <EmptyState title="No suppliers' bills this month.">
            Suppliers&apos; bills booked in payables for this month appear here.
          </EmptyState>
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Bill</th>
                <th>Date</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">CGST</th>
                <th className="text-right">SGST</th>
                <th className="text-right">IGST</th>
                <th className="text-right">Blocked</th>
              </tr>
            </thead>
            <tbody aria-label="Inward register">
              {d.inward.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.party}
                    {o.gstin && <div className="font-mono text-xs text-fg-muted">{o.gstin}</div>}
                  </td>
                  <td>
                    <Link
                      to="/accounts/vendor-bills/$billId"
                      params={{ billId: o.billId }}
                      className="text-accent hover:underline"
                    >
                      {o.billNo}
                    </Link>
                    {o.kind === 'debit_note' && <Badge>Debit note</Badge>}
                  </td>
                  <td>{shortDate(o.date)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.taxable)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.cgst)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.sgst)}</td>
                  <td className="text-right tabular-nums">{neg(o.kind, o.igst)}</td>
                  <td className="text-right tabular-nums">
                    {Number(o.blocked) ? rupees(o.blocked) : '-'}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={3}>Total</td>
                <td className="text-right tabular-nums">{rupees(d.inwardTotals.taxable)}</td>
                <td className="text-right tabular-nums">{rupees(d.inwardTotals.cgst)}</td>
                <td className="text-right tabular-nums">{rupees(d.inwardTotals.sgst)}</td>
                <td className="text-right tabular-nums">{rupees(d.inwardTotals.igst)}</td>
                <td className="text-right tabular-nums">{rupees(d.inwardTotals.blocked)}</td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function TwoB({ entityId, period }: { entityId: string; period: string }) {
  const qc = useQueryClient();
  const key = ['gstr2b', entityId, period];
  const r = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Recon>(`/api/tenant/accounts/gst/2b?entityId=${entityId}&period=${period}`),
  });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.upload<Recon>(
          `/api/tenant/accounts/gst/2b?entityId=${entityId}&period=${period}`,
          file,
        ),
      );
      toast.success(`GSTR-2B for ${period} uploaded`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card
      title="GSTR-2B against the purchase book"
      actions={
        <>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            aria-label="GSTR-2B file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          <Button
            type="button"
            variant="secondary"
            busy={busy}
            onClick={() => input.current?.click()}
          >
            <Upload className="size-4" aria-hidden /> Upload the 2B JSON
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {r.isPending ? (
        <Spinner />
      ) : r.isError ? (
        <Alert tone="danger">{describeError(r.error)}</Alert>
      ) : !r.data.upload ? (
        <p className="text-sm text-fg-muted">
          Download the month's GSTR-2B (JSON) from the GST portal and upload it here.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm" aria-label="2B counts">
            {r.data.counts!.matched} matched, {r.data.counts!.differs} differ,{' '}
            {r.data.counts!.in2bOnly} in 2B only, {r.data.counts!.inBooksOnly} not filed by the
            supplier. <span className="text-fg-muted">From {r.data.upload.fileName}.</span>
          </p>
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Status</th>
                <th>Supplier</th>
                <th>Bill</th>
                <th>Date</th>
                <th className="text-right">Taxable, 2B</th>
                <th className="text-right">Tax, 2B</th>
                <th className="text-right">Taxable, books</th>
                <th className="text-right">Tax, books</th>
              </tr>
            </thead>
            <tbody aria-label="2B reconciliation">
              {r.data.rows.map((x, i) => (
                <tr key={i}>
                  <td>
                    <Badge tone={RECON[x.status][1]}>{RECON[x.status][0]}</Badge>
                  </td>
                  <td>
                    {x.party}
                    <div className="font-mono text-xs text-fg-muted">{x.gstin}</div>
                  </td>
                  <td>
                    {x.billId ? (
                      <Link
                        to="/accounts/vendor-bills/$billId"
                        params={{ billId: x.billId }}
                        className="text-accent hover:underline"
                      >
                        {x.number}
                      </Link>
                    ) : (
                      x.number
                    )}
                  </td>
                  <td>{shortDate(x.date)}</td>
                  <td className="text-right tabular-nums">
                    {x.taxable2b ? rupees(x.taxable2b) : '-'}
                  </td>
                  <td className="text-right tabular-nums">{x.tax2b ? rupees(x.tax2b) : '-'}</td>
                  <td className="text-right tabular-nums">
                    {x.taxableBooks ? rupees(x.taxableBooks) : '-'}
                  </td>
                  <td className="text-right tabular-nums">
                    {x.taxBooks ? rupees(x.taxBooks) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}

// --- on a client bill ---

interface EInvoice {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQr: string;
}
interface BillGst {
  creditNotes: {
    id: string;
    number: string;
    date: string;
    reason: string;
    taxable: string;
    total: string;
    eInvoice: EInvoice | null;
  }[];
  eInvoice: EInvoice | null;
  mayPost: boolean;
}

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(text, { margin: 1, width: 160 }).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [text]);
  return src ? <img src={src} alt="e-invoice QR code" className="size-32" /> : null;
}

function IrnBlock({
  kind,
  id,
  e,
  mayPost,
  onSaved,
}: {
  kind: 'invoice' | 'credit_note';
  id: string;
  e: EInvoice | null;
  mayPost: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ irn: '', ackNo: '', ackDate: '', signedQr: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const json = () =>
    void api
      .download(`/api/tenant/accounts/e-invoices/${kind}/${id}/json`)
      .then(({ blob, fileName }) => saveFile(blob, fileName))
      .catch((err: unknown) => setError(describeError(err)));
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/tenant/accounts/e-invoices/${kind}/${id}`, {
        method: 'POST',
        body: f,
      });
      setOpen(false);
      toast.success('IRN recorded');
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      {e ? (
        <div className="flex flex-wrap items-start gap-4" aria-label="e-invoice">
          <Qr text={e.signedQr} />
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-fg-muted">IRN</dt>
            <dd className="break-all font-mono text-xs">{e.irn}</dd>
            <dt className="text-fg-muted">Ack. no.</dt>
            <dd>{e.ackNo}</dd>
            <dt className="text-fg-muted">Ack. date</dt>
            <dd>{e.ackDate}</dd>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-fg-muted print:hidden">No IRN recorded.</p>
      )}
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button type="button" variant="secondary" onClick={json}>
          <FileJson className="size-4" aria-hidden /> e-invoice JSON
        </Button>
        {mayPost && !open && (
          <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
            {e ? 'Replace the IRN' : 'Record the IRN'}
          </Button>
        )}
      </div>
      {open && (
        <form
          aria-label="Record the IRN"
          className="grid gap-2 sm:grid-cols-3 print:hidden"
          onSubmit={(ev) => void save(ev)}
        >
          <Field label="IRN">
            <Input
              value={f.irn}
              onChange={(x) => setF({ ...f, irn: x.target.value })}
              required
              maxLength={64}
            />
          </Field>
          <Field label="Ack. no.">
            <Input
              value={f.ackNo}
              onChange={(x) => setF({ ...f, ackNo: x.target.value })}
              required
              maxLength={30}
            />
          </Field>
          <Field label="Ack. date" hint="YYYY-MM-DD HH:MM">
            <Input
              value={f.ackDate}
              onChange={(x) => setF({ ...f, ackDate: x.target.value })}
              required
            />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Signed QR code">
              <Input
                value={f.signedQr}
                onChange={(x) => setF({ ...f, signedQr: x.target.value })}
                required
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The GST side of a certified client bill: its e-invoice and credit notes. */
export function ClientBillGst({ billId, certified }: { billId: string; certified: boolean }) {
  const qc = useQueryClient();
  const key = ['client-bill-gst', billId];
  // The GST side is part of the books: people without the accounts see the bill without it.
  const mayBooks = usePermission('accounts.view');
  const g = useQuery({
    queryKey: key,
    queryFn: () => api.request<BillGst>(`/api/tenant/client-bills/${billId}/gst`),
    enabled: certified && mayBooks,
    retry: false,
  });
  const [f, setF] = useState({ date: today(), reason: '', taxable: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  if (!certified || !mayBooks || g.isPending || g.isError) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['client-bill', billId] });
  };
  const raise = async (e: FormEvent) => {
    e.preventDefault();
    if (
      !(await confirm({
        title: `Raise a credit note for ${rupees(f.taxable)} before GST?`,
        body: 'The credit note is posted to the books against this invoice and goes into the GST returns. It cannot be withdrawn.',
        confirmLabel: 'Raise the credit note',
        tone: 'primary',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/tenant/client-bills/${billId}/credit-notes`, {
        method: 'POST',
        body: f,
      });
      setF({ date: today(), reason: '', taxable: '' });
      toast.success('Credit note raised');
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card title="e-invoice">
        <IrnBlock
          kind="invoice"
          id={billId}
          e={g.data.eInvoice}
          mayPost={g.data.mayPost}
          onSaved={refresh}
        />
      </Card>
      <Card title="Credit notes" className="print:hidden">
        {error && <Alert tone="danger">{error}</Alert>}
        {g.data.creditNotes.length === 0 ? (
          <p className="text-sm text-fg-muted">None.</p>
        ) : (
          <ul className="space-y-4" aria-label="Credit notes">
            {g.data.creditNotes.map((n) => (
              <li key={n.id} className="space-y-2">
                <div className="text-sm">
                  <span className="font-mono">{n.number}</span> {shortDate(n.date)}: {n.reason};
                  value {rupees(n.taxable)}, total {rupees(n.total)}
                </div>
                <IrnBlock
                  kind="credit_note"
                  id={n.id}
                  e={n.eInvoice}
                  mayPost={g.data.mayPost}
                  onSaved={refresh}
                />
              </li>
            ))}
          </ul>
        )}
        {g.data.mayPost && (
          <form
            aria-label="Credit note"
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => void raise(e)}
          >
            <Field label="Date">
              <Input
                type="date"
                className="w-40"
                value={f.date}
                onChange={(e) => setF({ ...f, date: e.target.value })}
                required
              />
            </Field>
            <Field label="Why">
              <Input
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Value before GST">
              <Input
                className="w-32 text-right"
                value={f.taxable}
                onChange={(e) => setF({ ...f, taxable: e.target.value })}
                required
              />
            </Field>
            <Button type="submit" busy={busy}>
              Raise a credit note
            </Button>
          </form>
        )}
      </Card>
    </>
  );
}
