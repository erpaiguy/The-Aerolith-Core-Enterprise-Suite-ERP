// Delivery follow-up on a purchase order (docs/wave8-plan.md step 8e.2): each line's instalments set against what
// came, and the buyer's expediting notes with the date the supplier promised.
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Table, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { numberLocale } from '../lib/locale';

interface FollowUp {
  deliverBy: string | null;
  receiptTolerancePct: string;
  lines: {
    lineKey: string;
    position: number;
    description: string;
    unit: string;
    ordered: string;
    outstanding: string;
    schedule: {
      dueOn: string;
      qty: string;
      came: string;
      short: string;
      state: string;
      note: string;
    }[];
  }[];
  notes: {
    id: string;
    notedOn: string;
    note: string;
    promisedOn: string | null;
    by: string | null;
  }[];
  mayEdit: boolean;
}
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  received: 'success',
  part: 'warning',
  due: 'neutral',
  overdue: 'danger',
};
const n = (v: string) => Number(v).toLocaleString(numberLocale());

export function DeliveryFollowUp({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const key = ['order-follow-up', orderId];
  const f = useQuery({
    queryKey: key,
    queryFn: () => api.request<FollowUp>(`/api/tenant/orders/${orderId}/follow-up`),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<{ dueOn: string; qty: string; note: string }[]>([]);
  const [note, setNote] = useState({ note: '', promisedOn: '' });
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: object, done: string) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request<FollowUp>(path, { method: 'POST', body }));
      toast.success(done);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const d = f.data;
  if (!d) return null;
  return (
    <Card title="Delivery follow-up" className="print:hidden">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        {d.deliverBy && <span>Deliver by {d.deliverBy}.</span>}
        {d.mayEdit ? (
          <label className="flex items-center gap-2">
            Receipts may run over by %
            <input
              type="number"
              min={0}
              max={25}
              step="0.5"
              className="w-20 rounded-md border border-line bg-surface px-2 py-1"
              defaultValue={Number(d.receiptTolerancePct)}
              onBlur={async (e) => {
                if (Number(e.target.value) === Number(d.receiptTolerancePct)) return;
                setError(null);
                try {
                  await api.request(`/api/tenant/orders/${orderId}/receipt-tolerance`, {
                    method: 'POST',
                    body: { pct: e.target.value || '0' },
                  });
                  toast.success('Receipt tolerance saved');
                  void qc.invalidateQueries({ queryKey: key });
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            />
          </label>
        ) : (
          Number(d.receiptTolerancePct) > 0 && (
            <span>Receipts may run over by {Number(d.receiptTolerancePct)}%.</span>
          )
        )}
      </div>
      <Table minWidth="40rem">
        <thead>
          <tr>
            <th>Line</th>
            <th className="text-right">Ordered</th>
            <th className="text-right">Still owed</th>
            <th>Instalments</th>
          </tr>
        </thead>
        <tbody aria-label="Delivery instalments">
          {d.lines.map((l) => (
            <tr key={l.lineKey}>
              <td>
                {l.position}. {l.description}
              </td>
              <td className="text-right tabular-nums">
                {n(l.ordered)} {l.unit}
              </td>
              <td className="text-right tabular-nums">{n(l.outstanding)}</td>
              <td>
                {editing === l.lineKey ? (
                  <form
                    aria-label="Instalments"
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        `/api/tenant/orders/${orderId}/schedule`,
                        {
                          lineKey: l.lineKey,
                          slots: rows.filter((r) => r.dueOn && r.qty),
                        },
                        `Instalments of line ${l.position} saved`,
                      ).then((ok) => ok && setEditing(null));
                    }}
                  >
                    {rows.map((r, i) => (
                      <div key={i} className="flex flex-wrap gap-2">
                        <Input
                          type="date"
                          aria-label="Due on"
                          value={r.dueOn}
                          onChange={(e) =>
                            setRows(
                              rows.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)),
                            )
                          }
                        />
                        <Input
                          aria-label="Quantity"
                          inputMode="decimal"
                          className="w-24"
                          value={r.qty}
                          onChange={(e) =>
                            setRows(
                              rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                            )
                          }
                        />
                        <Input
                          aria-label="Note"
                          value={r.note}
                          onChange={(e) =>
                            setRows(
                              rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setRows([...rows, { dueOn: '', qty: '', note: '' }])}
                      >
                        Add instalment
                      </Button>
                      <Button type="submit" variant="secondary">
                        Save instalments
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {l.schedule.map((s) => (
                      <span key={s.dueOn}>
                        {s.dueOn}: {n(s.qty)}{' '}
                        <Badge tone={TONE[s.state] ?? 'neutral'}>
                          {s.state === 'overdue' ? `${n(s.short)} overdue` : s.state}
                        </Badge>
                      </span>
                    ))}
                    {d.mayEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setRows(
                            l.schedule.length
                              ? l.schedule.map((s) => ({
                                  dueOn: s.dueOn,
                                  qty: s.qty,
                                  note: s.note,
                                }))
                              : [{ dueOn: '', qty: '', note: '' }],
                          );
                          setEditing(l.lineKey);
                        }}
                      >
                        {l.schedule.length ? 'Change instalments' : 'Set instalments'}
                      </Button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <h3 className="mt-4 text-sm font-semibold">Expediting</h3>
      {d.notes.length === 0 ? (
        <EmptyState title="No notes.">
          {d.mayEdit ? 'Note each chase with the supplier and the date they promise.' : undefined}
        </EmptyState>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Expediting notes">
          {d.notes.map((x) => (
            <li key={x.id}>
              {x.notedOn} {x.by && <span className="text-fg-muted">{x.by}:</span>} {x.note}
              {x.promisedOn && <Badge tone="neutral">promised {x.promisedOn}</Badge>}
            </li>
          ))}
        </ul>
      )}
      {d.mayEdit && (
        <form
          aria-label="Expediting note"
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              `/api/tenant/orders/${orderId}/expedite`,
              {
                note: note.note,
                promisedOn: note.promisedOn || null,
              },
              'Expediting note added',
            ).then((ok) => ok && setNote({ note: '', promisedOn: '' }));
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label="Note">
              <Input
                value={note.note}
                onChange={(e) => setNote({ ...note, note: e.target.value })}
                required
                minLength={3}
              />
            </Field>
          </div>
          <Field label="Promised for">
            <Input
              type="date"
              value={note.promisedOn}
              onChange={(e) => setNote({ ...note, promisedOn: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="secondary">
            Add note
          </Button>
        </form>
      )}
    </Card>
  );
}
