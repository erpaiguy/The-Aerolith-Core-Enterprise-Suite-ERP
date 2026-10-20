// Printable money documents (docs/wave7-plan.md step 7b.3): the RA bill with its abstract (a tax invoice once it has
// an invoice number), the receipt for a client's payment, the payment advice to each supplier in a payment run, and
// the payslip. On the company's letterhead.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ClientBill } from '../accounts/bills';
import { formatInr } from './money';
import { shortDate } from '../schedule/model';
import { Particulars, PrintDesk, PrintSheet, PrintTable, useEntityByName } from './Letterhead';
import { Loading, Signatures } from './PurchaseDocs';
import { rupeesInWords } from './words';
import { numberLocale } from '../lib/locale';

const right = 'text-right';
const num = (v: string | null) =>
  v === null || v === ''
    ? ''
    : Number(v).toLocaleString(numberLocale(), { maximumFractionDigits: 3 });

export function ClientBillPrint({ billId }: { billId: string }) {
  const bill = useQuery({
    queryKey: ['client-bill', billId],
    queryFn: () => api.request<ClientBill>(`/api/tenant/client-bills/${billId}`),
  });
  if (!bill.data) return <Loading q={bill} />;
  const b = bill.data;
  const f = b.certified ?? b.submitted ?? b.figures;
  const thisQty = new Map((f?.lines ?? []).map((l) => [l.lineKey, l]));
  const invoice = !!b.invoiceNo;
  const stage = b.certified ? 'Certified' : b.submitted ? 'As submitted' : 'Draft';
  return (
    <PrintSheet
      entityId={b.company.id}
      title={invoice ? `Tax invoice · RA bill ${b.raNo}` : `Running account bill ${b.raNo}`}
      meta={
        <>
          {invoice ? (
            <div className="font-mono font-semibold">
              {b.invoiceNo}
              {b.invoiceDate ? ` · ${shortDate(b.invoiceDate)}` : ''}
            </div>
          ) : null}
          <div>Work up to {shortDate(b.upto)}</div>
          <div>{stage}</div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs font-semibold uppercase">Bill to</div>
          <div className="font-semibold">{b.client?.name ?? '—'}</div>
          {b.client?.address ? (
            <div className="whitespace-pre-wrap text-sm">{b.client.address}</div>
          ) : null}
          {b.client?.gstin ? <div className="text-sm">GSTIN {b.client.gstin}</div> : null}
        </div>
        <Particulars
          rows={[
            ['Project', `${b.project.number} ${b.project.name}`],
            ['Site', [b.site.name, b.site.address].filter(Boolean).join(', ')],
            ['Place of supply', b.site.stateCode ? `State ${b.site.stateCode}` : ''],
            ['SAC', b.terms.sac ?? '9954'],
            ['Client reference', b.clientRef],
            ['Certified on', b.certifiedOn ? shortDate(b.certifiedOn) : ''],
          ]}
        />
      </div>
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase">Abstract</h2>
        <PrintTable>
          <thead>
            <tr>
              <th>Item</th>
              <th>Description</th>
              <th>Unit</th>
              <th className={right}>Rate</th>
              <th className={right}>Contract qty</th>
              <th className={right}>Up to previous</th>
              <th className={right}>This bill</th>
              <th className={right}>Up to date</th>
              <th className={right}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l) => {
              const t = thisQty.get(l.lineKey);
              return (
                <tr key={l.lineKey}>
                  <td className="font-mono">{l.code ?? l.position}</td>
                  <td>{l.description}</td>
                  <td>{l.unit ?? ''}</td>
                  <td className={right}>{formatInr(l.rate)}</td>
                  <td className={right}>{num(l.contractQty)}</td>
                  <td className={right}>{num(l.prevQty)}</td>
                  <td className={right}>{num(t?.thisQty ?? null)}</td>
                  <td className={right}>{num(l.certQty ?? l.cumQty)}</td>
                  <td className={right}>{t ? formatInr(t.amount) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </PrintTable>
      </section>
      {f ? (
        <section className="ml-auto w-[60%] break-inside-avoid">
          <h2 className="mb-1 text-sm font-bold uppercase">Summary</h2>
          <PrintTable>
            <tbody>
              <Row k="Value of work this bill" v={f.gross} />
              {f.escalation.map((e) => (
                <Row key={e.key} k={`Escalation: ${e.name}`} v={e.amount} />
              ))}
              <Row k="Taxable value" v={f.taxable} strong />
              {Number(f.cgst) ? <Row k={`CGST`} v={f.cgst} /> : null}
              {Number(f.sgst) ? <Row k={`SGST`} v={f.sgst} /> : null}
              {Number(f.igst) ? <Row k={`IGST`} v={f.igst} /> : null}
              <Row k="Invoice total" v={f.invoiceTotal} strong />
              {Number(f.retention) ? <Row k="Less: retention" v={f.retention} /> : null}
              {Number(f.advanceRecovery) ? (
                <Row k="Less: advance recovered" v={f.advanceRecovery} />
              ) : null}
              {b.deductions.map((d) => (
                <Row key={d.position} k={`Less: ${d.description}`} v={d.amount} />
              ))}
              <Row k="Net payable" v={f.net} strong />
            </tbody>
          </PrintTable>
          <p className="mt-1 text-sm italic">{rupeesInWords(f.invoiceTotal)} (invoice total)</p>
        </section>
      ) : null}
      <Signatures names={['Prepared by', "Client's engineer", 'Checked by']} />
    </PrintSheet>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-bold' : undefined}>
      <td>{k}</td>
      <td className="text-right">{formatInr(v)}</td>
    </tr>
  );
}

interface ClientReceipt {
  id: string;
  company: string;
  party: { id: string; name: string };
  receivedOn: string;
  bank: { code: string; name: string };
  amount: string;
  tds: string;
  reference: string;
  narration: string;
  status: 'posted' | 'cancelled';
  voucher: { id: string; number: string };
  allocations: {
    kind: 'bill' | 'retention' | 'advance';
    amount: string;
    raNo: number | null;
    invoiceNo: string | null;
    project: { number: string };
  }[];
}
const AGAINST = { bill: 'RA bill', retention: 'Retention released', advance: 'Advance' } as const;

export function ClientReceiptPrint({ receiptId }: { receiptId: string }) {
  const receipt = useQuery({
    queryKey: ['client-receipt', receiptId],
    queryFn: () => api.request<ClientReceipt>(`/api/tenant/accounts/client-receipts/${receiptId}`),
  });
  const entity = useEntityByName(receipt.data?.company);
  if (!receipt.data) return <Loading q={receipt} />;
  const r = receipt.data;
  return (
    <PrintSheet
      entityId={entity.data}
      title={`Receipt${r.status === 'cancelled' ? ' (cancelled)' : ''}`}
      meta={
        <>
          <div className="font-mono font-semibold">{r.voucher.number}</div>
          <div>{shortDate(r.receivedOn)}</div>
        </>
      }
    >
      <p>
        Received with thanks from <strong>{r.party.name}</strong> the sum of{' '}
        <strong>{formatInr(r.amount)}</strong> ({rupeesInWords(r.amount)}) into our account with{' '}
        {r.bank.name}
        {r.reference ? `, reference ${r.reference}` : ''}.
      </p>
      {Number(r.tds) ? (
        <p>Tax deducted at source by you on this payment: {formatInr(r.tds)}.</p>
      ) : null}
      {r.allocations.length > 0 ? (
        <PrintTable>
          <thead>
            <tr>
              <th>Against</th>
              <th>Project</th>
              <th>Invoice</th>
              <th className={right}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {r.allocations.map((a, k) => (
              <tr key={k}>
                <td>
                  {AGAINST[a.kind]}
                  {a.raNo ? ` ${a.raNo}` : ''}
                </td>
                <td>{a.project.number}</td>
                <td>{a.invoiceNo ?? ''}</td>
                <td className={right}>{formatInr(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </PrintTable>
      ) : null}
      {r.narration ? <p className="text-sm">{r.narration}</p> : null}
    </PrintSheet>
  );
}

interface PaymentRun {
  id: string;
  number: string;
  payOn: string;
  paidOn: string | null;
  status: string;
  company: string;
  bank: { code: string; name: string };
  lines: {
    position: number;
    kind: 'bill' | 'advance';
    amount: string;
    party: { id: string; name: string; accountNo: string | null; ifsc: string | null };
    bill: { id: string; billNo: string; billDate: string; total: string; tds: string } | null;
    project: { number: string; name: string } | null;
  }[];
}

/** One advice per supplier paid in the run: which of their bills it settles, and the TDS kept back. */
export function PaymentAdvicePrint({ runId }: { runId: string }) {
  const run = useQuery({
    queryKey: ['payment-run', runId],
    queryFn: () => api.request<PaymentRun>(`/api/tenant/accounts/payment-runs/${runId}`),
  });
  const entity = useEntityByName(run.data?.company);
  if (!run.data) return <Loading q={run} />;
  const x = run.data;
  const parties = [...new Map(x.lines.map((l) => [l.party.id, l.party])).values()];
  return (
    <PrintDesk>
      {parties.map((p) => {
        const lines = x.lines.filter((l) => l.party.id === p.id);
        const total = lines.reduce((n, l) => n + Number(l.amount), 0);
        return (
          <PrintSheet
            key={p.id}
            bare
            entityId={entity.data}
            title="Payment advice"
            meta={
              <>
                <div className="font-mono font-semibold">{x.number}</div>
                <div>{shortDate(x.paidOn ?? x.payOn)}</div>
              </>
            }
          >
            <Particulars
              rows={[
                ['To', p.name],
                [
                  'Paid into',
                  [p.accountNo && `A/c ${p.accountNo}`, p.ifsc && `IFSC ${p.ifsc}`]
                    .filter(Boolean)
                    .join(' · '),
                ],
                ['From', x.bank.name],
                [
                  'Status',
                  x.paidOn
                    ? `Paid on ${shortDate(x.paidOn)}`
                    : `To be paid on ${shortDate(x.payOn)}`,
                ],
              ]}
            />
            <PrintTable>
              <thead>
                <tr>
                  <th>Your bill</th>
                  <th>Date</th>
                  <th>Project</th>
                  <th className={right}>Bill total</th>
                  <th className={right}>TDS</th>
                  <th className={right}>Paid now</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.position}>
                    <td>{l.bill ? l.bill.billNo : 'Advance'}</td>
                    <td>{l.bill ? shortDate(l.bill.billDate) : ''}</td>
                    <td>{l.project ? `${l.project.number} ${l.project.name}` : ''}</td>
                    <td className={right}>{l.bill ? formatInr(l.bill.total) : ''}</td>
                    <td className={right}>
                      {l.bill && Number(l.bill.tds) ? formatInr(l.bill.tds) : ''}
                    </td>
                    <td className={right}>{formatInr(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  <td colSpan={5} className="text-right">
                    Total paid
                  </td>
                  <td className="text-right">{formatInr(String(total))}</td>
                </tr>
              </tfoot>
            </PrintTable>
            <p className="text-sm italic">{rupeesInWords(total)}</p>
          </PrintSheet>
        );
      })}
    </PrintDesk>
  );
}

interface Slip {
  month: string;
  company: string;
  code: string;
  name: string;
  designation: string | null;
  department: string;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  bankAccount: string | null;
  days: string;
  payableDays: string;
  earnings: { code: string; name: string; amount: number | string }[];
  deductions: { name: string; amount: number }[];
  gross: string;
  pf: { employee?: number | null };
  esiEmployee: string;
  pt: string;
  lwfEmployee: string;
  tds: string;
  net: string;
}

export function PayslipPrint({ runId, employeeId }: { runId: string; employeeId: string }) {
  const slip = useQuery({
    queryKey: ['payslip', runId, employeeId],
    queryFn: () => api.request<Slip>(`/api/tenant/payroll/runs/${runId}/payslips/${employeeId}`),
  });
  const entity = useEntityByName(slip.data?.company);
  if (!slip.data) return <Loading q={slip} />;
  const s = slip.data;
  const deductions = (
    [
      ['Provident fund', s.pf.employee ?? 0],
      ['ESI', s.esiEmployee],
      ['Professional tax', s.pt],
      ['Labour welfare fund', s.lwfEmployee],
      ['Income tax (TDS)', s.tds],
      ...s.deductions.map((d) => [d.name, d.amount] as const),
    ] as [string, number | string][]
  ).filter(([, v]) => Number(v) > 0);
  const totalDeductions = deductions.reduce((n, [, v]) => n + Number(v), 0);
  return (
    <PrintSheet
      entityId={entity.data}
      title="Payslip"
      meta={<div className="font-semibold">{s.month}</div>}
      signature={false}
    >
      <Particulars
        rows={[
          ['Employee', `${s.code} ${s.name}`],
          ['Designation', s.designation ?? ''],
          ['Department', s.department],
          ['PAN', s.pan ?? ''],
          ['UAN', s.uan ?? ''],
          ['ESI number', s.esiNumber ?? ''],
          ['Bank account', s.bankAccount ?? ''],
          ['Days paid', `${s.payableDays} of ${s.days}`],
        ]}
      />
      <div className="grid grid-cols-2 gap-4">
        <PrintTable>
          <thead>
            <tr>
              <th>Earnings</th>
              <th className={right}>₹</th>
            </tr>
          </thead>
          <tbody>
            {s.earnings.map((e) => (
              <tr key={`${e.code}-${e.name}`}>
                <td>{e.name}</td>
                <td className={right}>{formatInr(String(e.amount))}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td>Gross</td>
              <td className={right}>{formatInr(s.gross)}</td>
            </tr>
          </tbody>
        </PrintTable>
        <PrintTable>
          <thead>
            <tr>
              <th>Deductions</th>
              <th className={right}>₹</th>
            </tr>
          </thead>
          <tbody>
            {deductions.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className={right}>{formatInr(String(v))}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td>Total</td>
              <td className={right}>{formatInr(String(totalDeductions))}</td>
            </tr>
          </tbody>
        </PrintTable>
      </div>
      <p className="text-right font-bold">Net pay {formatInr(s.net)}</p>
      <p className="text-right text-sm italic">{rupeesInWords(s.net)}</p>
      <p className="text-center text-[8pt]">
        This is a computer-made payslip and needs no signature.
      </p>
    </PrintSheet>
  );
}
