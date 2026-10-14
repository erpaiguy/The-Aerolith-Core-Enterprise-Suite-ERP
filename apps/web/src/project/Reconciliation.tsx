// Material reconciliation (docs/wave7-plan.md step 7c.2): what the measured work should have taken of each material,
// by the rate analyses' norms, against what the stores issued; over the norm is wastage to look into.
import { Alert, Card, Input, Table } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatInr } from '../lib/format';

interface Rec {
  rows: {
    resource: { id: string; code: string; name: string; unit: string };
    theoretical: string;
    issued: string;
    issuedValue: string;
    difference: string;
    overPct: number | null;
    items: number;
  }[];
}
const q3 = (v: string) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export function MaterialReconciliation({ projectId }: { projectId: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const r = useQuery({
    queryKey: ['material-reconciliation', projectId, params.toString()],
    queryFn: () =>
      api.request<Rec>(
        `/api/tenant/projects/${projectId}/material-reconciliation?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      title="Reconciliation with measured work"
      actions={
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Input
            type="date"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          to
          <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      }
    >
      {r.isError ? (
        <Alert tone="danger">{describeError(r.error)}</Alert>
      ) : !r.data ? null : r.data.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No material measured or issued in this period.</p>
      ) : (
        <>
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Should have taken</th>
                <th className="text-right">Issued</th>
                <th className="text-right">Difference</th>
                <th className="text-right">Over the norm</th>
                <th className="text-right">Issued value</th>
              </tr>
            </thead>
            <tbody aria-label="Reconciliation">
              {r.data.rows.map((x) => (
                <tr key={x.resource.id}>
                  <td>
                    <span className="font-mono text-xs">{x.resource.code}</span> {x.resource.name}
                    <div className="text-xs text-fg-muted">
                      {x.items
                        ? `${x.items} measured item${x.items === 1 ? '' : 's'}`
                        : 'No norm: issued without measured work'}
                    </div>
                  </td>
                  <td className="text-right">
                    {q3(x.theoretical)} {x.resource.unit}
                  </td>
                  <td className="text-right">{q3(x.issued)}</td>
                  <td className="text-right">{q3(x.difference)}</td>
                  <td
                    className={`text-right ${x.overPct !== null && x.overPct > 3 ? 'font-medium text-danger' : ''}`}
                  >
                    {x.overPct === null ? '—' : `${x.overPct > 0 ? '+' : ''}${x.overPct}%`}
                  </td>
                  <td className="text-right">{formatInr(x.issuedValue)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-fg-muted">
            Should have taken: each measured item's quantity × what one unit takes by its rate
            analysis, the analysis's wastage allowed. Above 3% over is marked; under means the work
            used less, or stock is still at the workface.
          </p>
        </>
      )}
    </Card>
  );
}

interface Eva {
  items: {
    lineKey: string;
    code: string | null;
    description: string;
    unit: string | null;
    measured: string;
    materials: {
      resource: { id: string; code: string; name: string; unit: string };
      norm: string;
      estimated: string;
      issued: string;
      actualPerUnit: string | null;
      overPct: number | null;
    }[];
  }[];
  labour: {
    estimated: {
      resource: { code: string; name: string; unit: string };
      qty: string;
      cost: string;
    }[];
    estimatedCost: string;
    actualCost: string;
  };
}

/** Estimate against actual (docs/wave7-plan.md step 7c.3): per item, materials per unit; labour for the project. */
export function EstimateVsActual({ projectId }: { projectId: string }) {
  const r = useQuery({
    queryKey: ['estimate-vs-actual', projectId],
    queryFn: () => api.request<Eva>(`/api/tenant/projects/${projectId}/estimate-vs-actual`),
  });
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  if (!r.data) return null;
  const { items, labour } = r.data;
  return (
    <Card title="Estimate against actual">
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">No measured item has a rate analysis yet.</p>
      ) : (
        <Table minWidth="52rem">
          <thead>
            <tr>
              <th>Item and material</th>
              <th className="text-right">Estimated per unit</th>
              <th className="text-right">Actual per unit</th>
              <th className="text-right">Estimated</th>
              <th className="text-right">Issued to the item</th>
              <th className="text-right">Over</th>
            </tr>
          </thead>
          <tbody aria-label="Estimate against actual">
            {items.flatMap((i) => [
              <tr key={i.lineKey} className="bg-surface-2">
                <td colSpan={6} className="font-medium">
                  <span className="font-mono text-xs">{i.code}</span> {i.description}{' '}
                  <span className="text-xs font-normal text-fg-muted">
                    {q3(i.measured)} {i.unit} measured
                  </span>
                </td>
              </tr>,
              ...i.materials.map((m) => (
                <tr key={`${i.lineKey}-${m.resource.id}`}>
                  <td className="pl-6">
                    {m.resource.name}{' '}
                    <span className="text-xs text-fg-muted">({m.resource.unit})</span>
                  </td>
                  <td className="text-right">{q3(m.norm)}</td>
                  <td className="text-right">
                    {m.actualPerUnit === null ? '—' : q3(m.actualPerUnit)}
                  </td>
                  <td className="text-right">{q3(m.estimated)}</td>
                  <td className="text-right">{q3(m.issued)}</td>
                  <td
                    className={`text-right ${m.overPct !== null && m.overPct > 3 ? 'font-medium text-danger' : ''}`}
                  >
                    {m.overPct === null ? '—' : `${m.overPct > 0 ? '+' : ''}${m.overPct}%`}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </Table>
      )}
      <div className="mt-4 text-sm" data-testid="labour-estimate">
        <span className="font-medium">Labour:</span> estimated {formatInr(labour.estimatedCost)} for
        the work measured
        {labour.estimated.length
          ? ` (${labour.estimated.map((l) => `${q3(l.qty)} ${l.resource.unit} ${l.resource.name}`).join(', ')})`
          : ''}
        ; wage sheets passed {formatInr(labour.actualCost)}.
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        Issues count against an item only when the issue slip names it; labour is not booked to
        items, so it is compared for the project as a whole.
      </p>
    </Card>
  );
}
