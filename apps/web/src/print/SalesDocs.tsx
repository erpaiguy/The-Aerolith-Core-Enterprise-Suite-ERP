// Printable sales papers (docs/wave7-plan.md step 7b.5): a booking's cost sheet (the unit's price, GST and the
// payment plan, as RERA asks it set out) and a demand letter for a stage, with the buyer's account to date.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatInr } from './money';
import { shortDate } from '../schedule/model';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { Loading, useProjectEntity } from './PurchaseDocs';
import { rupeesInWords } from './words';
import { numberLocale } from '../lib/locale';

interface Booking {
  id: string;
  number: string;
  status: string;
  value: string;
  bookedOn: string;
  agreementOn: string | null;
  agreementNumber: string;
  buyer: string;
  coApplicant: string;
  phone: string;
  email: string;
  pan: string | null;
  address: string;
  unit: string;
  unitKind: string;
  floor: number;
  carpetSqm: string;
  ratePerSqm: string;
  parking: string;
  charges: string;
  gstPct: string;
  projectId: string;
  reraNumber: string;
  interestPct: string;
  plan: {
    position: number;
    name: string;
    pct: string;
    trigger: string;
    reachedOn: string | null;
  }[];
  demands: {
    id: string;
    number: string;
    stage: string | null;
    raisedOn: string;
    dueOn: string;
    base: string;
    cgst: string;
    sgst: string;
    total: string;
    paid: string;
    open: string;
    overdue: boolean;
  }[];
  receipts: {
    number: string;
    receivedOn: string;
    amount: string;
    mode: string;
    reference: string;
  }[];
  totals: { demanded: string; received: string; outstanding: string; interestDue: string };
}

const useBooking = (id: string) =>
  useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.request<Booking>(`/api/tenant/sales/bookings/${id}`),
  });
const sqft = (sqm: string) =>
  (Number(sqm) * 10.7639).toLocaleString(numberLocale(), { maximumFractionDigits: 0 });
const right = 'text-right';

function Buyer({ b }: { b: Booking }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase">Buyer</div>
      <div className="font-semibold">
        {b.buyer}
        {b.coApplicant ? ` and ${b.coApplicant}` : ''}
      </div>
      {b.address ? <div className="whitespace-pre-wrap text-sm">{b.address}</div> : null}
      <div className="text-sm">
        {[b.phone, b.email, b.pan && `PAN ${b.pan}`].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

export function CostSheetPrint({ bookingId }: { bookingId: string }) {
  const booking = useBooking(bookingId);
  const entity = useProjectEntity(booking.data?.projectId);
  if (!booking.data) return <Loading q={booking} />;
  const b = booking.data;
  const base = Number(b.carpetSqm) * Number(b.ratePerSqm);
  const gst = (Number(b.value) * Number(b.gstPct)) / 100;
  return (
    <PrintSheet
      entityId={entity.data}
      title="Cost sheet"
      meta={
        <>
          <div className="font-mono font-semibold">{b.number}</div>
          <div>Booked {shortDate(b.bookedOn)}</div>
          {b.reraNumber ? <div>MahaRERA {b.reraNumber}</div> : null}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        <Buyer b={b} />
        <Particulars
          rows={[
            ['Unit', `${b.unit} (${b.unitKind}, floor ${b.floor})`],
            [
              'Carpet area',
              `${Number(b.carpetSqm).toLocaleString(numberLocale())} sq m (${sqft(b.carpetSqm)} sq ft)`,
            ],
            [
              'Agreement',
              b.agreementOn
                ? `${b.agreementNumber || 'Registered'} of ${shortDate(b.agreementOn)}`
                : '',
            ],
          ]}
        />
      </div>
      <section className="w-[75%]">
        <h2 className="mb-1 text-sm font-bold uppercase">Price</h2>
        <PrintTable>
          <tbody>
            <tr>
              <td>
                Carpet area {Number(b.carpetSqm).toLocaleString(numberLocale())} sq m at{' '}
                {formatInr(b.ratePerSqm)} per sq m
              </td>
              <td className={right}>{formatInr(String(base))}</td>
            </tr>
            {Number(b.parking) ? (
              <tr>
                <td>Parking</td>
                <td className={right}>{formatInr(b.parking)}</td>
              </tr>
            ) : null}
            {Number(b.charges) ? (
              <tr>
                <td>Other charges</td>
                <td className={right}>{formatInr(b.charges)}</td>
              </tr>
            ) : null}
            <tr className="font-bold">
              <td>Agreement value</td>
              <td className={right}>{formatInr(b.value)}</td>
            </tr>
            <tr>
              <td>GST at {Number(b.gstPct)}%</td>
              <td className={right}>{formatInr(String(gst))}</td>
            </tr>
            <tr className="font-bold">
              <td>Total payable to us</td>
              <td className={right}>{formatInr(String(Number(b.value) + gst))}</td>
            </tr>
          </tbody>
        </PrintTable>
        <p className="mt-1 text-sm italic">{rupeesInWords(Number(b.value) + gst)}</p>
      </section>
      {b.plan.length > 0 ? (
        <section>
          <h2 className="mb-1 text-sm font-bold uppercase">Payment plan</h2>
          <PrintTable>
            <thead>
              <tr>
                <th>#</th>
                <th>Stage</th>
                <th className={right}>Share</th>
                <th className={right}>Amount</th>
                <th className={right}>GST</th>
                <th className={right}>Total</th>
              </tr>
            </thead>
            <tbody>
              {b.plan.map((s) => {
                const amount = (Number(b.value) * Number(s.pct)) / 100;
                const tax = (amount * Number(b.gstPct)) / 100;
                return (
                  <tr key={s.position}>
                    <td>{s.position}</td>
                    <td>
                      {s.name}
                      {s.reachedOn ? ` (reached ${shortDate(s.reachedOn)})` : ''}
                    </td>
                    <td className={right}>{Number(s.pct)}%</td>
                    <td className={right}>{formatInr(String(amount))}</td>
                    <td className={right}>{formatInr(String(tax))}</td>
                    <td className={right}>{formatInr(String(amount + tax))}</td>
                  </tr>
                );
              })}
            </tbody>
          </PrintTable>
        </section>
      ) : null}
      <p className="text-[9pt]">
        Stamp duty, registration fees and society charges are paid by the buyer as the law sets
        them, and are not in the figures above. Each payment is due within the days set in the
        agreement of the demand; later payments bear interest at {Number(b.interestPct)}% a year as
        the agreement and MahaRERA rules provide.
      </p>
    </PrintSheet>
  );
}

export function DemandLetterPrint({
  bookingId,
  demandId,
}: {
  bookingId: string;
  demandId: string;
}) {
  const booking = useBooking(bookingId);
  const entity = useProjectEntity(booking.data?.projectId);
  if (!booking.data) return <Loading q={booking} />;
  const b = booking.data;
  const d = b.demands.find((x) => x.id === demandId);
  if (!d)
    return <Loading q={{ isPending: false, isError: true, error: new Error('No such demand.') }} />;
  return (
    <PrintSheet
      entityId={entity.data}
      title="Demand letter"
      meta={
        <>
          <div className="font-mono font-semibold">{d.number}</div>
          <div>{shortDate(d.raisedOn)}</div>
          {b.reraNumber ? <div>MahaRERA {b.reraNumber}</div> : null}
        </>
      }
    >
      <Buyer b={b} />
      <p>Dear {b.buyer.split(' ')[0]},</p>
      <p>
        Sub: Your unit <strong>{b.unit}</strong> (booking {b.number})
        {d.stage ? (
          <>
            {' '}
            — stage <strong>{d.stage}</strong>
          </>
        ) : null}
        .
      </p>
      <p>
        As per your payment plan, the following is now due from you. Please pay it by{' '}
        <strong>{shortDate(d.dueOn)}</strong>.
      </p>
      <section className="w-[70%]">
        <PrintTable>
          <tbody>
            <tr>
              <td>Amount due for the stage</td>
              <td className={right}>{formatInr(d.base)}</td>
            </tr>
            {Number(d.cgst) ? (
              <tr>
                <td>CGST</td>
                <td className={right}>{formatInr(d.cgst)}</td>
              </tr>
            ) : null}
            {Number(d.sgst) ? (
              <tr>
                <td>SGST</td>
                <td className={right}>{formatInr(d.sgst)}</td>
              </tr>
            ) : null}
            <tr className="font-bold">
              <td>Total of this demand</td>
              <td className={right}>{formatInr(d.total)}</td>
            </tr>
            {Number(d.paid) ? (
              <tr>
                <td>Received against it</td>
                <td className={right}>{formatInr(d.paid)}</td>
              </tr>
            ) : null}
            <tr className="font-bold">
              <td>To pay now</td>
              <td className={right}>{formatInr(d.open)}</td>
            </tr>
          </tbody>
        </PrintTable>
        <p className="mt-1 text-sm italic">{rupeesInWords(d.open)}</p>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase">Your account to date</h2>
        <Particulars
          rows={[
            ['Agreement value', formatInr(b.value)],
            ['Demanded so far', formatInr(b.totals.demanded)],
            ['Received so far', formatInr(b.totals.received)],
            ['Outstanding', formatInr(b.totals.outstanding)],
            ['Interest due', Number(b.totals.interestDue) ? formatInr(b.totals.interestDue) : ''],
          ]}
        />
      </section>
      <p className="text-sm">
        Payments after the due date bear interest at {Number(b.interestPct)}% a year as the
        agreement and MahaRERA rules provide. Please quote your booking number with your payment.
        Ignore this letter if you have already paid.
      </p>
    </PrintSheet>
  );
}
