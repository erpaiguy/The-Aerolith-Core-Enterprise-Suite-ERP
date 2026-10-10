// An item's measurement book (docs/wave2a-plan.md step 6): the work done on a contract BOQ item, entry by entry, and a
// new entry from dimensions (nos × length × breadth × height, deductions) or as one figure. Entries are never changed:
// a wrong one is reversed by an entry of the opposite quantity.
import { Alert, Badge, Button, Field, Input, Spinner } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { formatQty, formatRate, type BoqRow } from '../boq/model';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';

interface Dim {
  description: string;
  nos: string;
  length: string;
  breadth: string;
  height: string;
  deduct: boolean;
}

interface Book {
  code: string | null;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  done: string;
  pct: number | null;
  entries: {
    id: string;
    measuredOn: string;
    qty: string;
    dims: Dim[] | null;
    description: string;
    reverses: string | null;
    reversedBy: string | null;
    createdBy: string | null;
  }[];
}

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const blank = (): Dim => ({
  description: '',
  nos: '',
  length: '',
  breadth: '',
  height: '',
  deduct: false,
});
/** The product of the dimensions given, as the server works it out (shown while typing). */
const dimQty = (d: Dim) => {
  const xs = [d.nos, d.length, d.breadth, d.height].filter((x) => x.trim() !== '').map(Number);
  if (!xs.length || xs.some((x) => !Number.isFinite(x))) return 0;
  const q = Math.round(xs.reduce((a, b) => a * b, 1) * 10_000) / 10_000;
  return d.deduct ? -q : q;
};

export function MeasurementBook({
  boqId,
  row,
  canRecord,
  onClose,
  onChanged,
}: {
  boqId: string;
  row: BoqRow;
  canRecord: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const key = ['measurement-book', boqId, row.id];
  const book = useQuery({
    queryKey: key,
    queryFn: () => api.request<Book>(`/api/tenant/boqs/${boqId}/lines/${row.id}/progress`),
  });
  const [mode, setMode] = useState<'dims' | 'qty'>('dims');
  const [on, setOn] = useState(indiaToday());
  const [qty, setQty] = useState('');
  const [dims, setDims] = useState<Dim[]>([blank()]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = Math.round(dims.reduce((s, d) => s + dimQty(d), 0) * 10_000) / 10_000;
  const save = async (fn: () => Promise<Book>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await fn());
      onChanged();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const record = () =>
    save(() =>
      api.request<Book>(`/api/tenant/boqs/${boqId}/lines/${row.id}/progress`, {
        method: 'POST',
        body: {
          measuredOn: on,
          description,
          ...(mode === 'qty'
            ? { qty: qty.trim() }
            : {
                dims: dims
                  .filter((d) => [d.nos, d.length, d.breadth, d.height].some((x) => x.trim()))
                  .map((d) => ({
                    ...d,
                    nos: d.nos || null,
                    length: d.length || null,
                    breadth: d.breadth || null,
                    height: d.height || null,
                  })),
              }),
        },
      }),
    ).then((ok) => {
      if (ok) {
        setQty('');
        setDims([blank()]);
        setDescription('');
      }
    });
  const reverse = (id: string) => {
    const reason = window.prompt('Why is this entry wrong?');
    if (!reason || reason.trim().length < 3) return;
    void save(() =>
      api.request<Book>(`/api/tenant/boqs/${boqId}/progress/${id}/reverse`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    );
  };
  const b = book.data;
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-16"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Measurement book"
        className="w-full max-w-3xl space-y-4 rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              Measurement book · {row.code ? `${row.code} · ` : ''}
              {row.description}
            </h2>
            {b && (
              <p className="text-sm text-fg-muted" data-testid="book-summary">
                Done {formatQty(b.done)} of {formatQty(b.qty)} {b.unit ?? ''}
                {b.pct !== null && ` (${b.pct}%)`} · rate {formatRate(b.rate)}
                {b.pct !== null && b.pct > 100 && (
                  <span className="ml-2">
                    <Badge tone="warning">more than the BOQ quantity</Badge>
                  </span>
                )}
              </p>
            )}
          </div>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        {book.isPending && <Spinner />}
        {book.isError && <Alert tone="danger">{describeError(book.error)}</Alert>}
        {b && b.entries.length > 0 && (
          <table className="w-full text-sm" aria-label="Entries">
            <thead className="text-left text-xs text-fg-muted">
              <tr>
                <th className="py-1">Date</th>
                <th className="py-1 text-right">Quantity</th>
                <th className="py-1 pl-3">Description</th>
                <th className="py-1">By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.entries.map((e) => (
                <tr
                  key={e.id}
                  className={`border-t border-line ${e.reversedBy ? 'text-fg-subtle line-through' : ''}`}
                >
                  <td className="py-1 tabular-nums">{shortDate(e.measuredOn)}</td>
                  <td className="py-1 text-right tabular-nums">{formatQty(e.qty)}</td>
                  <td className="py-1 pl-3">
                    {e.description}
                    {e.dims && (
                      <span className="ml-1 text-xs text-fg-muted">
                        ({e.dims.length} row{e.dims.length === 1 ? '' : 's'} of dimensions)
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-xs text-fg-muted">{e.createdBy ?? ''}</td>
                  <td className="py-1 text-right">
                    {canRecord && !e.reverses && !e.reversedBy && (
                      <Button
                        variant="ghost"
                        aria-label={`Reverse the entry of ${shortDate(e.measuredOn)}`}
                        title="Reverse this entry (it stays on the record)"
                        onClick={() => reverse(e.id)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {b && b.entries.length === 0 && (
          <p className="text-sm text-fg-muted">Nothing measured yet.</p>
        )}
        {canRecord && (
          <form
            className="space-y-3 border-t border-line pt-4"
            aria-label="New entry"
            onSubmit={(e) => {
              e.preventDefault();
              void record();
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Measured on">
                <Input
                  type="date"
                  value={on}
                  max={indiaToday()}
                  onChange={(e) => setOn(e.target.value)}
                  required
                />
              </Field>
              <div className="flex gap-1 pb-1" role="radiogroup" aria-label="Measured as">
                {(['dims', 'qty'] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    variant={mode === m ? 'secondary' : 'ghost'}
                    onClick={() => setMode(m)}
                  >
                    {m === 'dims' ? 'Dimensions' : 'Quantity'}
                  </Button>
                ))}
              </div>
              {mode === 'qty' && (
                <Field label={`Quantity (${row.unit ?? ''})`}>
                  <Input
                    inputMode="decimal"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className="w-32"
                  />
                </Field>
              )}
            </div>
            {mode === 'dims' && (
              <div className="space-y-1">
                {dims.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <Input
                      aria-label={`Row ${i + 1} description`}
                      placeholder="Where"
                      value={d.description}
                      className="w-40"
                      onChange={(e) =>
                        setDims(
                          dims.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)),
                        )
                      }
                    />
                    {(['nos', 'length', 'breadth', 'height'] as const).map((f) => (
                      <Input
                        key={f}
                        aria-label={`Row ${i + 1} ${f}`}
                        placeholder={f === 'nos' ? 'Nos' : f[0]!.toUpperCase() + f.slice(1)}
                        inputMode="decimal"
                        value={d[f]}
                        className="w-20"
                        onChange={(e) =>
                          setDims(dims.map((x, k) => (k === i ? { ...x, [f]: e.target.value } : x)))
                        }
                      />
                    ))}
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        aria-label={`Row ${i + 1} deduct`}
                        checked={d.deduct}
                        onChange={(e) =>
                          setDims(
                            dims.map((x, k) => (k === i ? { ...x, deduct: e.target.checked } : x)),
                          )
                        }
                      />
                      deduct
                    </label>
                    <span className="w-20 text-right text-xs tabular-nums">
                      {formatQty(String(dimQty(d)))}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <Button type="button" variant="ghost" onClick={() => setDims([...dims, blank()])}>
                    <Plus className="size-4" aria-hidden /> Row
                  </Button>
                  <span className="text-sm" data-testid="entry-total">
                    Total {formatQty(String(total))} {row.unit ?? ''}
                  </span>
                </div>
              </div>
            )}
            <Field label="Description">
              <Input
                value={description}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" busy={busy} disabled={mode === 'qty' ? !qty.trim() : total === 0}>
              Record
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
