// The deviation statement (docs/wave8-plan.md step 8d.5), in the PWD form: each agreement item's quantity as tendered
// against what is executed to date, the excess and saving at the agreement rate and the percentage against the
// contract's deviation limit, then the extra items and the abstract.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { formatInr } from './money';
import { Loading, Signatures } from './PurchaseDocs';
import { numberLocale } from '../lib/locale';

interface Statement {
  project: { id: string; number: string; name: string; entityId: string };
  limitPct: number;
  items: {
    boq: string;
    code: string;
    description: string;
    unit: string;
    rate: string;
    tendered: string;
    tenderedAmount: string;
    executed: string;
    executedAmount: string;
    excess: string;
    excessAmount: string;
    saving: string;
    savingAmount: string;
    pct: number | null;
    beyond: 'excess' | 'saving' | null;
    variations: string;
  }[];
  extras: {
    code: string;
    description: string;
    unit: string;
    rate: string;
    executed: string;
    amount: string;
    variations: string;
  }[];
  totals: {
    tendered: string;
    executed: string;
    excess: string;
    saving: string;
    extra: string;
    net: string;
    netPct: number | null;
    beyond: number;
  };
}
const right = 'text-right';
const q = (v: string) => (Number(v) === 0 ? '' : Number(v).toLocaleString(numberLocale()));
const amt = (v: string) => (Number(v) === 0 ? '' : formatInr(v));

export function DeviationStatementPrint({ projectId }: { projectId: string }) {
  const r = useQuery({
    queryKey: ['deviation-statement', projectId],
    queryFn: () => api.request<Statement>(`/api/tenant/projects/${projectId}/deviation-statement`),
  });
  if (!r.data) return <Loading q={r} />;
  const d = r.data;
  return (
    <PrintSheet
      entityId={d.project.entityId}
      title="Deviation statement"
      meta={<div className="font-semibold">{d.project.number}</div>}
    >
      <Particulars
        rows={[
          ['Name of work', `${d.project.number} ${d.project.name}`],
          ['Deviation limit', `${d.limitPct}% of the agreement quantity of an item`],
          ['Executed quantities', 'as measured in the measurement book to date'],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>Item</th>
            <th>Description</th>
            <th>Unit</th>
            <th className={right}>Rate</th>
            <th className={right}>Agreement qty</th>
            <th className={right}>Amount</th>
            <th className={right}>Executed qty</th>
            <th className={right}>Amount</th>
            <th className={right}>Excess qty</th>
            <th className={right}>Amount</th>
            <th className={right}>Saving qty</th>
            <th className={right}>Amount</th>
            <th className={right}>Deviation %</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((i, k) => (
            <tr key={k}>
              <td>{i.code}</td>
              <td>{i.description}</td>
              <td>{i.unit}</td>
              <td className={right}>{Number(i.rate).toLocaleString(numberLocale())}</td>
              <td className={right}>{q(i.tendered)}</td>
              <td className={right}>{amt(i.tenderedAmount)}</td>
              <td className={right}>{q(i.executed)}</td>
              <td className={right}>{amt(i.executedAmount)}</td>
              <td className={right}>{q(i.excess)}</td>
              <td className={right}>{amt(i.excessAmount)}</td>
              <td className={right}>{q(i.saving)}</td>
              <td className={right}>{amt(i.savingAmount)}</td>
              <td className={right}>{i.pct === null ? '' : `${i.pct > 0 ? '+' : ''}${i.pct}`}</td>
              <td>
                {i.beyond === 'excess'
                  ? 'Beyond the limit: sanction needed'
                  : i.beyond === 'saving'
                    ? 'Saving beyond the limit'
                    : ''}
                {i.variations && ` ${i.variations}`}
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td colSpan={5}>Total</td>
            <td className={right}>{formatInr(d.totals.tendered)}</td>
            <td />
            <td className={right}>{formatInr(d.totals.executed)}</td>
            <td />
            <td className={right}>{formatInr(d.totals.excess)}</td>
            <td />
            <td className={right}>{formatInr(d.totals.saving)}</td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </PrintTable>
      {d.extras.length > 0 && (
        <>
          <h2 className="mt-4 font-semibold">Extra items</h2>
          <PrintTable>
            <thead>
              <tr>
                <th>Item</th>
                <th>Description</th>
                <th>Unit</th>
                <th className={right}>Rate</th>
                <th className={right}>Executed qty</th>
                <th className={right}>Amount</th>
                <th>Sanctioned by</th>
              </tr>
            </thead>
            <tbody>
              {d.extras.map((x, k) => (
                <tr key={k}>
                  <td>{x.code}</td>
                  <td>{x.description}</td>
                  <td>{x.unit}</td>
                  <td className={right}>{Number(x.rate).toLocaleString(numberLocale())}</td>
                  <td className={right}>{q(x.executed)}</td>
                  <td className={right}>{amt(x.amount)}</td>
                  <td>{x.variations}</td>
                </tr>
              ))}
            </tbody>
          </PrintTable>
        </>
      )}
      <h2 className="mt-4 font-semibold">Abstract</h2>
      <Particulars
        rows={[
          ['Agreement amount (items)', formatInr(d.totals.tendered)],
          ['Excess', formatInr(d.totals.excess)],
          ['Less saving', formatInr(d.totals.saving)],
          ['Extra items', formatInr(d.totals.extra)],
          [
            'Net deviation',
            `${formatInr(d.totals.net)}${d.totals.netPct === null ? '' : ` (${d.totals.netPct}% of the agreement)`}`,
          ],
          ['Items beyond the limit', String(d.totals.beyond)],
        ]}
      />
      <Signatures names={['Prepared by', 'Checked by', 'Engineer-in-charge']} />
    </PrintSheet>
  );
}
