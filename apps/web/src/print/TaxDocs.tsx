// Form 16A (docs/wave8-plan.md step 8b.3): the certificate of tax deducted at source from a supplier's bills in a
// quarter, with the challans that deposited it, worked from the 26Q data. The official form is downloaded from TRACES;
// this one is for the supplier's file until then.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { shortDate } from '../schedule/model';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { formatInr } from './money';
import { Loading } from './PurchaseDocs';
import { rupeesInWords } from './words';

interface Form16a {
  quarter: string;
  from: string;
  to: string;
  deductor: { name: string; legalName: string | null; tan: string | null; pan: string | null };
  deductee: { name: string; address: string | null; pan: string | null };
  rows: {
    billId: string;
    billNo: string;
    section: string;
    date: string;
    paid: string;
    rate: string;
    tds: string;
    challan: { bsrCode: string; challanNo: string; depositedOn: string } | null;
  }[];
  paid: string;
  tds: string;
  deposited: string;
  complete: boolean;
}
const right = 'text-right';

export function Form16aPrint({
  entityId,
  quarter,
  partyId,
}: {
  entityId: string;
  quarter: string;
  partyId: string;
}) {
  const q = useQuery({
    queryKey: ['form-16a', entityId, quarter, partyId],
    queryFn: () =>
      api.request<Form16a>(
        `/api/tenant/accounts/tds/16a?entityId=${entityId}&quarter=${quarter}&partyId=${partyId}`,
      ),
  });
  if (!q.data) return <Loading q={q} />;
  const f = q.data;
  return (
    <PrintSheet
      entityId={entityId}
      title={`Certificate of tax deducted at source (Form 16A)${f.complete ? '' : ' — draft'}`}
      meta={
        <>
          <div className="font-semibold">{f.quarter}</div>
          <div>
            {shortDate(f.from)} to {shortDate(f.to)}
          </div>
        </>
      }
    >
      <Particulars
        rows={[
          ['Deductor', f.deductor.legalName ?? f.deductor.name],
          ['TAN', f.deductor.tan ?? 'not set'],
          ['PAN of the deductor', f.deductor.pan ?? ''],
          ['Deductee', f.deductee.name],
          ['PAN of the deductee', f.deductee.pan ?? 'not given'],
          ['Address', f.deductee.address ?? ''],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>Bill</th>
            <th>Section</th>
            <th>Date</th>
            <th className={right}>Amount paid or credited</th>
            <th className={right}>Rate %</th>
            <th className={right}>Tax deducted</th>
            <th>BSR code</th>
            <th>Deposited on</th>
            <th>Challan no.</th>
          </tr>
        </thead>
        <tbody>
          {f.rows.map((r) => (
            <tr key={r.billId}>
              <td>{r.billNo}</td>
              <td>{r.section}</td>
              <td>{shortDate(r.date)}</td>
              <td className={right}>{formatInr(r.paid)}</td>
              <td className={right}>{Number(r.rate)}</td>
              <td className={right}>{formatInr(r.tds)}</td>
              <td>{r.challan?.bsrCode ?? '—'}</td>
              <td>{r.challan ? shortDate(r.challan.depositedOn) : 'not deposited'}</td>
              <td>{r.challan?.challanNo ?? ''}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td colSpan={3}>Total</td>
            <td className={right}>{formatInr(f.paid)}</td>
            <td />
            <td className={right}>{formatInr(f.tds)}</td>
            <td colSpan={3} />
          </tr>
        </tbody>
      </PrintTable>
      <p className="mt-3 text-sm">
        Certified that a sum of {formatInr(f.deposited)} ({rupeesInWords(f.deposited)}) has been
        deducted and deposited to the credit of the Central Government, as above.
        {f.complete ? '' : ' Some of the tax is not yet deposited: this is a draft.'}
      </p>
    </PrintSheet>
  );
}
