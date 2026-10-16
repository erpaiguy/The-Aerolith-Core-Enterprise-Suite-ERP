// Free-issue material to subcontractors (docs/wave8-plan.md step 8a.3): on a work order, how much of each material a
// unit of its work should take, the wastage allowed and the penal rate beyond it, with where the order stands; on a
// draft bill, the excess over the allowance for the work it certifies, recovered as a back-charge when accepted.
import { Alert, Button, Card, Input, Select, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { describeError, formatInr } from '../../lib/format';
import { ResourcePicker } from '../../procurement/ResourcePicker';

interface Row {
  resource: { id: string; code: string; name: string; unit: string };
  issued: string;
  returned: string;
  theoretical: string;
  allowed: string;
  excess: string;
  recoveredBefore: string;
  toRecover: string;
  rate: string;
  amount: string;
  recoveredHere: string | null;
}
interface Term {
  lineKey: string;
  resourceId: string;
  perUnit: string;
  wastagePct: string;
  penalRate: string;
  resource?: string;
  resourceUnit?: string;
}
interface ForOrder {
  order: { id: string; number: string };
  terms: (Term & { resource: string; resourceUnit: string; line: string; unit: string })[];
  lines: { lineKey: string; description: string; unit: string }[];
  rows: Row[];
}
const n = (v: string) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const right = 'text-right';

function Rows({ rows }: { rows: Row[] }) {
  return (
    <Table minWidth="48rem">
      <thead>
        <tr>
          <th>Material</th>
          <th className={right}>Issued (net)</th>
          <th className={right}>Work should take</th>
          <th className={right}>Allowed</th>
          <th className={right}>Beyond</th>
          <th className={right}>Recovered</th>
          <th className={right}>To recover</th>
        </tr>
      </thead>
      <tbody aria-label="Free-issue material">
        {rows.map((r) => (
          <tr key={r.resource.id}>
            <td>
              {r.resource.name} <span className="text-xs text-fg-muted">{r.resource.unit}</span>
            </td>
            <td className={right}>{n(String(Number(r.issued) - Number(r.returned)))}</td>
            <td className={right}>{n(r.theoretical)}</td>
            <td className={right}>{n(r.allowed)}</td>
            <td className={`${right} ${Number(r.excess) > 0 ? 'text-danger' : ''}`}>
              {n(r.excess)}
            </td>
            <td className={right}>{n(r.recoveredBefore)}</td>
            <td className={right}>
              {Number(r.amount) > 0 ? (
                <>
                  {formatInr(r.amount)}
                  <div className="text-xs text-fg-muted">
                    {n(r.toRecover)} at {formatInr(r.rate)}
                  </div>
                </>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** On the work order: its material norms, editable by the billing team, and where it stands. */
export function FreeIssueOrder({ orderId, mayEdit }: { orderId: string; mayEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['free-issue', orderId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.request<ForOrder>(`/api/tenant/work-orders/${orderId}/free-issue`),
  });
  const [draft, setDraft] = useState<Term[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return null;
  const terms = draft ?? q.data.terms;
  const edit = (i: number, k: keyof Term, v: string) =>
    setDraft(terms.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  const save = async () => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<ForOrder>(`/api/tenant/work-orders/${orderId}/free-issue`, {
          method: 'PUT',
          body: {
            items: terms.map(({ lineKey, resourceId, perUnit, wastagePct, penalRate }) => ({
              lineKey,
              resourceId,
              perUnit,
              wastagePct,
              penalRate,
            })),
          },
        }),
      );
      setDraft(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Free-issue material" className="print:hidden">
      <p className="mb-2 text-sm text-fg-muted">
        Material the stores issue against this order is the subcontractor's to account for: what a
        unit of each line should take, the wastage allowed, and the rate for what goes beyond.
      </p>
      {terms.length ? (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Line</th>
              <th>Material</th>
              <th className={right}>Per unit</th>
              <th className={right}>Wastage %</th>
              <th className={right}>Penal rate</th>
              <th />
            </tr>
          </thead>
          <tbody aria-label="Material norms">
            {terms.map((t, i) => (
              <tr key={`${t.lineKey}-${t.resourceId}`}>
                <td>
                  {mayEdit ? (
                    <Select
                      aria-label="Line"
                      value={t.lineKey}
                      onChange={(e) => edit(i, 'lineKey', e.target.value)}
                    >
                      {q.data!.lines.map((l) => (
                        <option key={l.lineKey} value={l.lineKey}>
                          {l.description} ({l.unit})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    q.data!.lines.find((l) => l.lineKey === t.lineKey)?.description
                  )}
                </td>
                <td>
                  {t.resource} <span className="text-xs text-fg-muted">{t.resourceUnit}</span>
                </td>
                {(['perUnit', 'wastagePct', 'penalRate'] as const).map((k) => (
                  <td key={k} className={right}>
                    {mayEdit ? (
                      <Input
                        aria-label={k}
                        inputMode="decimal"
                        className="w-24 text-right"
                        value={t[k]}
                        onChange={(e) => edit(i, k, e.target.value)}
                      />
                    ) : (
                      n(t[k])
                    )}
                  </td>
                ))}
                <td>
                  {mayEdit ? (
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${t.resource ?? 'material'}`}
                      onClick={() => setDraft(terms.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-fg-muted">No material is set as free issue on this order.</p>
      )}
      {mayEdit && q.data.lines.length ? (
        <div className="mt-3 space-y-2">
          <ResourcePicker
            onPick={(r) =>
              setDraft([
                ...terms,
                {
                  lineKey: q.data!.lines[0]!.lineKey,
                  resourceId: r.id,
                  perUnit: '0',
                  wastagePct: '0',
                  penalRate: r.rate ?? '0',
                  resource: r.name,
                  resourceUnit: r.unit,
                },
              ])
            }
          />
          {draft ? (
            <div className="flex gap-2">
              <Button onClick={() => void save()}>Save the norms</Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {q.data.rows.length ? (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-semibold">On all work measured so far</h3>
          <Rows rows={q.data.rows} />
        </div>
      ) : null}
    </Card>
  );
}

/** On a bill: the excess for the work it certifies; recovered as back-charges on a draft. */
export function FreeIssueBill({
  billId,
  mayRecover,
  onRecovered,
}: {
  billId: string;
  mayRecover: boolean;
  onRecovered: () => void;
}) {
  const qc = useQueryClient();
  const key = ['free-issue-bill', billId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{ rows: Row[] }>(`/api/tenant/subcontract-bills/${billId}/free-issue`),
  });
  const [error, setError] = useState<string | null>(null);
  if (!q.data || !q.data.rows.length) return null;
  const due = q.data.rows.filter((r) => Number(r.amount) > 0 && r.recoveredHere === null);
  const recover = async () => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<{ rows: Row[] }>(
          `/api/tenant/subcontract-bills/${billId}/free-issue/recover`,
          { method: 'POST', body: {} },
        ),
      );
      onRecovered();
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Free-issue material" className="print:hidden">
      <Rows rows={q.data.rows} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {mayRecover && due.length ? (
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={() => void recover()}>Recover on this bill</Button>
          <span className="text-sm text-fg-muted">
            Adds {formatInr(String(due.reduce((t, r) => t + Number(r.amount), 0)))} as back-charges.
          </span>
        </div>
      ) : null}
    </Card>
  );
}
