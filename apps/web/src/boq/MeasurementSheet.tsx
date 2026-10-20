// Measurement sheet of one BOQ item (docs/04-features.md E4): rows of nos × length × breadth × height, blank
// dimensions skipped, deductions subtracted. The item's quantity becomes the total. Rows can be pasted from Excel.
import { Alert, Button, Dialog, Input, Spinner, toast } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ClipboardEvent } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { formatQty, parseDecimal, type BoqHeader, type BoqRow } from './model';

interface Row {
  key: number;
  description: string;
  nos: string;
  length: string;
  breadth: string;
  height: string;
  deduct: boolean;
}
type Dim = 'nos' | 'length' | 'breadth' | 'height';
const DIMS: { key: Dim; label: string }[] = [
  { key: 'nos', label: 'Nos' },
  { key: 'length', label: 'Length' },
  { key: 'breadth', label: 'Breadth' },
  { key: 'height', label: 'Height / depth' },
];

let nextKey = 1;
const blank = (): Row => ({
  key: nextKey++,
  description: '',
  nos: '',
  length: '',
  breadth: '',
  height: '',
  deduct: false,
});

/** A dimension as typed: blank, a number ("1,250.5") or a formula ("=2*3.5"). */
function dim(text: string): { value: string | null } | { error: string } {
  if (text.trim() === '') return { value: null };
  const r = parseDecimal(text);
  if ('error' in r) return r;
  if (r.value !== null && r.value.startsWith('-')) return { error: 'Use Deduct for deductions' };
  return r;
}

/** Shown while typing; the server's figures replace it on save. */
function rowQty(r: Row): number | null {
  const vals = DIMS.map((d) => dim(r[d.key]));
  if (vals.some((v) => 'error' in v)) return null;
  const nums = vals
    .map((v) => ('value' in v ? v.value : null))
    .filter((v): v is string => v !== null);
  if (nums.length === 0) return null;
  const q = Math.round(nums.reduce((a, b) => a * Number(b), 1) * 10_000) / 10_000;
  return r.deduct ? -q : q;
}

export function MeasurementSheet({
  boqId,
  item,
  canEdit,
  currentVersion,
  onSaved,
  onClose,
}: {
  boqId: string;
  item: BoqRow;
  canEdit: boolean;
  /** The item's newest row version (the grid may have saved since the sheet opened). */
  currentVersion: () => number;
  onSaved: (rows: BoqRow[], header: BoqHeader) => void;
  onClose: () => void;
}) {
  const saved = useQuery({
    queryKey: ['measurements', boqId, item.id],
    queryFn: () =>
      api.request<
        {
          description: string;
          nos: string | null;
          length: string | null;
          breadth: string | null;
          height: string | null;
          deduct: boolean;
        }[]
      >(`/api/tenant/boqs/${boqId}/lines/${item.id}/measurements`),
    gcTime: 0,
  });
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    if (saved.data && rows === null) {
      const trim = (v: string | null) => (v === null ? '' : v.replace(/\.?0+$/, ''));
      setRows(
        saved.data.length === 0
          ? [blank()]
          : saved.data.map((m) => ({
              key: nextKey++,
              description: m.description,
              nos: trim(m.nos),
              length: trim(m.length),
              breadth: trim(m.breadth),
              height: trim(m.height),
              deduct: m.deduct,
            })),
      );
    }
  }, [saved.data, rows]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs!.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** Rows copied from a spreadsheet: description, nos, length, breadth, height (a leading "Deduct" deducts). */
  const paste = (e: ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const pasted = text
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const c = l.split('\t').map((x) => x.trim());
        const numericFirst = c[0] !== undefined && 'value' in dim(c[0]) && c[0] !== '';
        const [description = '', nos = '', length = '', breadth = '', height = ''] = numericFirst
          ? ['', ...c]
          : c;
        return {
          ...blank(),
          description,
          nos,
          length,
          breadth,
          height,
          deduct: /^deduct/i.test(description),
        };
      });
    setRows((rs) => [...rs!.filter((r) => rowQty(r) !== null || r.description), ...pasted]);
  };

  const filled = (rows ?? []).filter(
    (r) => r.description.trim() || DIMS.some((d) => r[d.key].trim()),
  );
  const problems = filled.flatMap((r, i) => {
    const errs = DIMS.map((d) => [d.label, dim(r[d.key])] as const).filter(([, v]) => 'error' in v);
    if (errs.length)
      return [
        `Row ${i + 1}: ${errs.map(([l, v]) => `${l} ${'error' in v ? v.error : ''}`).join('; ')}`,
      ];
    if (rowQty(r) === null)
      return [`Row ${i + 1}: give at least one of nos, length, breadth or height`];
    return [];
  });
  const total = filled.reduce((s, r) => s + (rowQty(r) ?? 0), 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = filled.map((r) => {
        const v = (d: Dim) => {
          const x = dim(r[d]);
          return 'value' in x ? x.value : null;
        };
        return {
          description: r.description,
          nos: v('nos'),
          length: v('length'),
          breadth: v('breadth'),
          height: v('height'),
          deduct: r.deduct,
        };
      });
      const res = await api.request<{ rows: BoqRow[]; header: BoqHeader }>(
        `/api/tenant/boqs/${boqId}/lines/${item.id}/measurements`,
        { method: 'POST', body: { rowVersion: currentVersion(), rows: body } },
      );
      onSaved(res.rows, res.header);
      toast.success(filled.length === 0 ? 'Measurement sheet removed' : 'Measurements saved');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Measurement sheet"
      size="xl"
      description={
        <>
          {item.code && <span className="font-mono">{item.code} </span>}
          {item.description || 'Item'} {item.unit && `(${item.unit})`}
        </>
      }
      footer={
        canEdit &&
        !saved.isPending &&
        !saved.isError &&
        rows !== null && (
          <>
            <Button variant="secondary" onClick={() => setRows([...rows, blank()])}>
              <Plus className="size-4" aria-hidden /> Row
            </Button>
            <span className="flex-1" />
            {saved.data && saved.data.length > 0 && (
              <Button variant="ghost" busy={busy} onClick={() => setRows([])}>
                Clear sheet
              </Button>
            )}
            <Button busy={busy} disabled={problems.length > 0} onClick={() => void save()}>
              {filled.length === 0 ? 'Save (no sheet)' : 'Save and use total'}
            </Button>
          </>
        )
      }
    >
      <div onPaste={canEdit ? paste : undefined}>
        {saved.isPending || rows === null ? (
          <Spinner />
        ) : saved.isError ? (
          <Alert tone="danger">{describeError(saved.error)}</Alert>
        ) : (
          <>
            <p className="mb-2 text-xs text-fg-muted">
              Quantity = nos × length × breadth × height; leave unused dimensions blank. Formulas
              like =2*3.5 work. Paste rows from Excel (description, nos, length, breadth, height).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm" aria-label="Measurements">
                <thead className="text-xs text-fg-muted">
                  <tr className="[&_th]:px-1 [&_th]:pb-1 [&_th]:font-medium">
                    <th className="w-6 text-left">#</th>
                    <th className="text-left">Description</th>
                    {DIMS.map((d) => (
                      <th key={d.key} className="w-24 text-right">
                        {d.label}
                      </th>
                    ))}
                    <th className="w-16 text-center">Deduct</th>
                    <th className="w-28 text-right">Quantity</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const q = rowQty(r);
                    return (
                      <tr key={r.key} className="[&_td]:px-1 [&_td]:py-0.5">
                        <td className="text-fg-muted">{i + 1}</td>
                        <td>
                          <Input
                            aria-label={`Row ${i + 1} description`}
                            value={r.description}
                            onChange={(e) => set(r.key, { description: e.target.value })}
                            disabled={!canEdit}
                          />
                        </td>
                        {DIMS.map((d) => (
                          <td key={d.key}>
                            <Input
                              aria-label={`Row ${i + 1} ${d.label.toLowerCase()}`}
                              className={`text-right ${'error' in dim(r[d.key]) ? 'border-danger' : ''}`}
                              value={r[d.key]}
                              onChange={(e) => set(r.key, { [d.key]: e.target.value })}
                              inputMode="decimal"
                              disabled={!canEdit}
                            />
                          </td>
                        ))}
                        <td className="text-center">
                          <input
                            type="checkbox"
                            aria-label={`Row ${i + 1} deduct`}
                            checked={r.deduct}
                            onChange={(e) => set(r.key, { deduct: e.target.checked })}
                            disabled={!canEdit}
                          />
                        </td>
                        <td
                          className={`text-right tabular-nums ${q !== null && q < 0 ? 'text-danger' : ''}`}
                        >
                          {q === null ? '' : formatQty(String(q))}
                        </td>
                        <td className="text-right">
                          {canEdit && (
                            <Button
                              variant="ghost"
                              aria-label={`Remove row ${i + 1}`}
                              onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} className="pt-2 text-right font-medium">
                      Total
                    </td>
                    <td
                      className="pt-2 text-right font-semibold tabular-nums"
                      data-testid="measurement-total"
                    >
                      {formatQty(String(Math.round(total * 10_000) / 10_000))} {item.unit}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            {problems.length > 0 && (
              <div className="mt-2">
                <Alert tone="warning">{problems.join('. ')}</Alert>
              </div>
            )}
            {error && (
              <div className="mt-2">
                <Alert tone="danger">{error}</Alert>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
