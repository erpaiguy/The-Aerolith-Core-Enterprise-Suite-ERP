// An order revision's lines with their GST, and the totals: the subtotal before GST, the GST added on top, the total.
import { Table } from '@aerolith/ui';
import { formatAmount, formatQty, formatRate } from '../boq/model';
import type { OrderRevision } from './orders';

/** ₹ to the paisa, as on the order. */
export const rupees = (v: string | null) =>
  v === null
    ? '-'
    : v.trim().startsWith('-')
      ? `-₹${formatAmount(v.trim().slice(1))}`
      : `₹${formatAmount(v)}`;

export function OrderLines({ r }: { r: OrderRevision }) {
  const intra = r.supply === 'intra';
  const inter = r.supply === 'inter';
  return (
    <Table minWidth="48rem">
      <thead>
        <tr>
          <th className="w-8">#</th>
          <th>Description</th>
          <th>HSN/SAC</th>
          <th className="text-right">Quantity</th>
          <th className="text-right">Rate</th>
          <th className="text-right">Amount</th>
          <th className="text-right">GST</th>
          {intra && <th className="text-right">CGST</th>}
          {intra && <th className="text-right">SGST</th>}
          {inter && <th className="text-right">IGST</th>}
        </tr>
      </thead>
      <tbody aria-label="Order lines">
        {r.lines.map((l) => (
          <tr key={l.position}>
            <td className="tabular-nums text-fg-muted">{l.position}</td>
            <td>
              {l.description}
              {l.resourceCode && (
                <span className="ml-2 font-mono text-xs text-fg-muted">{l.resourceCode}</span>
              )}
            </td>
            <td className="font-mono text-xs">{l.hsn ?? ''}</td>
            <td className="whitespace-nowrap text-right tabular-nums">
              {formatQty(l.qty)} {l.unit}
            </td>
            <td className="text-right tabular-nums">{formatRate(l.rate)}</td>
            <td className="text-right tabular-nums">{rupees(l.amount)}</td>
            <td className="text-right tabular-nums">{Number(l.gstPct)}%</td>
            {intra && <td className="text-right tabular-nums">{rupees(l.cgst)}</td>}
            {intra && <td className="text-right tabular-nums">{rupees(l.sgst)}</td>}
            {inter && <td className="text-right tabular-nums">{rupees(l.igst)}</td>}
          </tr>
        ))}
      </tbody>
      <tfoot data-testid="order-totals">
        <TotalRow label="Before GST" value={r.subtotal} />
        {intra && <TotalRow label="CGST" value={r.cgst} />}
        {intra && <TotalRow label="SGST" value={r.sgst} />}
        {inter && <TotalRow label="IGST" value={r.igst} />}
        <TotalRow label="Total with GST" value={r.total} strong />
      </tfoot>
    </Table>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td colSpan={5} className="text-right text-sm text-fg-muted">
        {label}
      </td>
      <td className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`}>
        {rupees(value)}
      </td>
      <td colSpan={4} />
    </tr>
  );
}
