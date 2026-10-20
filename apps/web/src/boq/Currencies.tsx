// The BOQ's exchange rates (docs/wave1-plan.md step 13): rupees for one unit of each currency items are priced in.
// Changing a rate re-prices those items; type "USD 1200" in an item's rate to price it in a currency.
import { Alert, Button, Dialog, Field, Input, toast, useConfirm } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatDateTime } from '../lib/format';

interface Currency {
  code: string;
  rate: string;
  items: number;
  updatedAt: string;
}

const plain = (v: string) => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function CurrenciesDialog({
  boqId,
  canEdit,
  onChanged,
  onClose,
}: {
  boqId: string;
  canEdit: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({
    queryKey: ['boq-currencies', boqId],
    queryFn: () => api.request<Currency[]>(`/api/tenant/boqs/${boqId}/currencies`),
  });
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const save = async (c: string, r: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.request<{ changed: number; currencies: Currency[] }>(
        `/api/tenant/boqs/${boqId}/currencies/${c.trim().toUpperCase()}`,
        { method: 'POST', body: { rate: r.trim() } },
      );
      qc.setQueryData(['boq-currencies', boqId], res.currencies);
      setNote(
        res.changed
          ? `${res.changed} item${res.changed === 1 ? '' : 's'} re-priced at the new rate.`
          : `${c.toUpperCase()} saved.`,
      );
      setCode('');
      setRate('');
      if (res.changed) onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: string) => {
    if (
      !(await confirm({
        title: `Remove ${c}?`,
        body: 'No item is priced in it. Its exchange rate is forgotten.',
        confirmLabel: `Remove ${c}`,
        tone: 'danger',
      }))
    )
      return;
    setError(null);
    try {
      qc.setQueryData(
        ['boq-currencies', boqId],
        await api.request<Currency[]>(`/api/tenant/boqs/${boqId}/currencies/${c}/delete`, {
          method: 'POST',
        }),
      );
      toast.success(`${c} removed`);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Dialog open onClose={onClose} title="Currencies">
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Price an item in another currency by typing it with its rate, for example{' '}
          <span className="font-mono">USD 1200</span>. Its rupee rate is that at the exchange rate
          below; changing the exchange rate re-prices every such item.
        </p>
        {list.data && list.data.length > 0 && (
          <ul
            className="divide-y divide-line rounded-md border border-line"
            aria-label="Exchange rates"
          >
            {list.data.map((c) => (
              <li key={c.code} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-12 font-mono font-semibold">{c.code}</span>
                <span className="flex-1">
                  ₹{plain(c.rate)} · {c.items} item{c.items === 1 ? '' : 's'}
                  <span className="block text-xs text-fg-subtle">
                    set {formatDateTime(c.updatedAt)}
                  </span>
                </span>
                {canEdit && (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCode(c.code);
                        setRate(plain(c.rate));
                      }}
                    >
                      Change
                    </Button>
                    {c.items === 0 && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove ${c.code}`}
                        onClick={() => void remove(c.code)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save(code, rate);
            }}
          >
            <Field label="Currency">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={3}
                className="w-20 font-mono"
                placeholder="USD"
              />
            </Field>
            <Field label="Rupees for one">
              <Input
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                inputMode="decimal"
                className="w-36"
              />
            </Field>
            <Button type="submit" busy={busy} disabled={code.length !== 3 || !rate.trim()}>
              Save rate
            </Button>
          </form>
        )}
        {note && <Alert tone="success">{note}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
