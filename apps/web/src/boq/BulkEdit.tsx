// Bulk edit (docs/wave1-plan.md step 13): one change to every item in the selected lines, sections' contents
// included, done by the server in one go however many lines that is.
import { Alert, Button, Field, Input, Select } from '@aerolith/ui';
import { X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { KIND_LABEL, type ItemKind } from './model';

type Action = 'scale' | 'rate' | 'unit' | 'item_kind' | 'clear_rates';
const ACTIONS: Record<Action, string> = {
  scale: 'Raise or lower rates by a percentage',
  rate: 'Set the rate',
  unit: 'Set the unit',
  item_kind: 'Set the kind of item',
  clear_rates: 'Clear the rates',
};

export function BulkEditDialog({
  boqId,
  selection,
  onClose,
  onDone,
}: {
  boqId: string;
  selection: { anchor: string; to: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action>('scale');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<ItemKind>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changed: number; total: string } | null>(null);
  const needsValue = action === 'scale' || action === 'rate' || action === 'unit';
  const apply = async () => {
    setBusy(true);
    setError(null);
    const body =
      action === 'scale'
        ? { kind: 'scale', pct: value.trim() }
        : action === 'rate'
          ? { kind: 'rate', rate: value.trim() }
          : action === 'unit'
            ? { kind: 'unit', unit: value.trim() || null }
            : action === 'item_kind'
              ? { kind: 'item_kind', itemKind: kind }
              : { kind: 'clear_rates' };
    try {
      setResult(
        await api.request<{ changed: number; total: string }>(`/api/tenant/boqs/${boqId}/bulk`, {
          method: 'POST',
          body: { from: selection.anchor, to: selection.to, action: body },
        }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-24"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bulk edit"
        className="w-full max-w-md space-y-4 rounded-lg border border-line bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h2 className="font-semibold">Bulk edit</h2>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        {result ? (
          <>
            <Alert tone="success">
              {result.changed.toLocaleString('en-IN')} item{result.changed === 1 ? '' : 's'}{' '}
              changed.
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onDone}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Applies to every item in the selected lines, including those inside selected sections.
              A rate set here replaces the rate from a rate analysis, as typing it would.
            </p>
            <Field label="Change">
              <Select value={action} onChange={(e) => setAction(e.target.value as Action)}>
                {(Object.keys(ACTIONS) as Action[]).map((a) => (
                  <option key={a} value={a}>
                    {ACTIONS[a]}
                  </option>
                ))}
              </Select>
            </Field>
            {needsValue && (
              <Field
                label={action === 'scale' ? 'Percentage' : action === 'rate' ? 'Rate (₹)' : 'Unit'}
                hint={
                  action === 'scale'
                    ? '10 raises every rate by 10 %; -5 lowers it by 5 %.'
                    : undefined
                }
              >
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  inputMode={action === 'unit' ? 'text' : 'decimal'}
                  autoFocus
                />
              </Field>
            )}
            {action === 'item_kind' && (
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
                  {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                busy={busy}
                disabled={needsValue && action !== 'unit' && !value.trim()}
                onClick={() => void apply()}
              >
                Apply
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
