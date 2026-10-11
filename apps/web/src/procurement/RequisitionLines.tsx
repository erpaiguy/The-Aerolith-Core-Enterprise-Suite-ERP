// A requisition's lines, read only: on its page once submitted, and for the approver.
import { Table } from '@aerolith/ui';
import { formatInr } from '../lib/format';
import { formatQty, formatRate } from '../boq/model';
import { shortDate } from '../schedule/model';
import { budgetLeft, type RequisitionLine } from './model';

export function RequisitionLines({ lines, total }: { lines: RequisitionLine[]; total: string }) {
  return (
    <Table minWidth="52rem">
      <thead>
        <tr>
          <th className="w-8">#</th>
          <th>What</th>
          <th className="text-right">Quantity</th>
          <th className="text-right">Rate</th>
          <th className="text-right">Amount</th>
          <th>For</th>
          <th>Budget</th>
          <th>Needed by</th>
        </tr>
      </thead>
      <tbody aria-label="Requisition lines">
        {lines.map((l) => (
          <tr key={l.position}>
            <td className="tabular-nums text-fg-muted">{l.position}</td>
            <td>
              {l.resourceCode && <span className="mr-2 font-mono text-xs">{l.resourceCode}</span>}
              {l.description}
              {l.notes && <span className="block text-xs text-fg-muted">{l.notes}</span>}
            </td>
            <td className="whitespace-nowrap text-right tabular-nums">
              {formatQty(l.qty)} {l.unit}
            </td>
            <td className="text-right tabular-nums">{l.rate ? formatRate(l.rate) : '-'}</td>
            <td className="text-right tabular-nums">{l.amount ? formatInr(l.amount) : '-'}</td>
            <td className="text-xs">
              {l.boqCode && (
                <span className="block" title={l.boqDescription ?? ''}>
                  BOQ {l.boqCode}
                </span>
              )}
              {l.wbsCode && (
                <span className="block text-fg-muted">
                  WBS {l.wbsCode} {l.wbsName}
                </span>
              )}
            </td>
            <td className="text-xs" data-testid={`budget-${l.position}`}>
              <Budget line={l} />
            </td>
            <td className="whitespace-nowrap tabular-nums">{shortDate(l.neededBy)}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td />
          <td>Estimated total</td>
          <td />
          <td />
          <td className="text-right tabular-nums" data-testid="requisition-total">
            {formatInr(total)}
          </td>
          <td colSpan={3} />
        </tr>
      </tbody>
    </Table>
  );
}

function Budget({ line: l }: { line: RequisitionLine }) {
  if (!l.resourceId || !l.hasBudget) return null;
  const b = budgetLeft(l, l.qty);
  if (!b) return <span className="text-warning">not in the budget</span>;
  return (
    <span className={b.over ? 'font-medium text-danger' : 'text-fg-muted'}>
      {formatQty(String(b.left))} of {formatQty(String(b.budget))} left
      {b.over && `: ${formatQty(String(Number(l.qty) - b.left))} over`}
    </span>
  );
}
