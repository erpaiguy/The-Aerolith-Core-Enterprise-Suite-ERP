// Schedule-of-rates tendering on a tender (docs/wave8-plan.md step 8f.2): whether it is quoted item by item or as a
// percentage on the estimate; the estimate's items citing the schedule and taking its rates; and the item-wise
// comparative of every bidder's rates.
import { Alert, Badge, Button, Card, Field, Input, Select, Table, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError, formatInr } from '../lib/format';

interface Mode {
  rateMode: 'item_rate' | 'percentage';
  quotedPct: string | null;
  estimate: string | null;
  quotedValue: string | null;
}
interface Comparative {
  boqId: string | null;
  lines: {
    lineId: string;
    lineKey: string;
    code: string | null;
    description: string;
    unit: string | null;
    qty: string;
    rate: string | null;
    sorCode: string | null;
    rates: Record<string, string>;
    lowest: string | null;
    lowestBy: string[];
  }[];
  bidders: { key: string; name: string; total: string; complete: boolean; rank: number | null }[];
}
interface SorItem {
  id: string;
  code: string;
  description: string;
  unit: string;
  rate: string;
  book: string;
}

export function SorTendering({ tenderId, canEdit }: { tenderId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const mode = useQuery({
    queryKey: ['tender-rate-mode', tenderId],
    queryFn: () => api.request<Mode>(`/api/tenant/tenders/${tenderId}/rate-mode`),
  });
  const cmp = useQuery({
    queryKey: ['tender-item-comparative', tenderId],
    queryFn: () => api.request<Comparative>(`/api/tenant/tenders/${tenderId}/item-comparative`),
  });
  const [pct, setPct] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cite, setCite] = useState<{ lineId: string; q: string } | null>(null);
  const found = useQuery({
    queryKey: ['sor-items', cite?.q],
    queryFn: () => api.request<SorItem[]>(`/api/tenant/sor-items?q=${encodeURIComponent(cite!.q)}`),
    enabled: !!cite && cite.q.trim().length >= 2,
  });
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['tender-rate-mode', tenderId] });
      void qc.invalidateQueries({ queryKey: ['tender-item-comparative', tenderId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const m = mode.data;
  const c = cmp.data;
  const post = (path: string, body: object) => api.request(path, { method: 'POST', body });
  return (
    <>
      <Card title="Schedule of rates and the quote">
        {error && <Alert tone="danger">{error}</Alert>}
        {m && (
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <Field label="Quoted as">
              <Select
                value={m.rateMode}
                disabled={!canEdit}
                onChange={(e) =>
                  void run(() =>
                    post(`/api/tenant/tenders/${tenderId}/rate-mode`, {
                      rateMode: e.target.value,
                      quotedPct: m.quotedPct,
                    }),
                  )
                }
              >
                <option value="item_rate">Item rates</option>
                <option value="percentage">A percentage on the estimate</option>
              </Select>
            </Field>
            {m.rateMode === 'percentage' && (
              <>
                <Field label="Our percentage (− below)">
                  <Input
                    className="w-24 text-right"
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={pct ?? m.quotedPct ?? ''}
                    onChange={(e) => setPct(e.target.value)}
                    onBlur={() => {
                      if (pct === null) return;
                      void run(() =>
                        post(`/api/tenant/tenders/${tenderId}/rate-mode`, {
                          rateMode: 'percentage',
                          quotedPct: pct.trim() || null,
                        }),
                      ).then(() => setPct(null));
                    }}
                  />
                </Field>
                <span className="pb-2">
                  Estimate {m.estimate ? formatInr(m.estimate) : 'not set'}
                  {m.quotedValue && ` · our quote ${formatInr(m.quotedValue)}`}
                </span>
              </>
            )}
          </div>
        )}
        {c && c.boqId && c.lines.length > 0 && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Estimate items and the schedule</h3>
              {canEdit && c.lines.some((l) => l.sorCode) && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void run(
                      () => post(`/api/tenant/boqs/${c.boqId}/sor/apply`, {}),
                      'SOR rates taken into the estimate',
                    )
                  }
                >
                  Take the SOR rates
                </Button>
              )}
            </div>
            <Table minWidth="40rem">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Estimate rate</th>
                  <th>SOR item</th>
                </tr>
              </thead>
              <tbody aria-label="Estimate items and the schedule">
                {c.lines.map((l) => (
                  <tr key={l.lineKey}>
                    <td>
                      {l.code && <span className="mr-2 font-mono text-xs">{l.code}</span>}
                      {l.description}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(l.qty)} {l.unit}
                    </td>
                    <td className="text-right tabular-nums">{l.rate ? formatInr(l.rate) : '-'}</td>
                    <td>
                      {cite?.lineId === l.lineId ? (
                        <span className="flex flex-col gap-1">
                          <Input
                            aria-label="Find in the schedule"
                            placeholder="Code or words"
                            value={cite.q}
                            onChange={(e) => setCite({ ...cite, q: e.target.value })}
                          />
                          {(found.data ?? []).slice(0, 8).map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className="text-left text-xs hover:underline"
                              onClick={() =>
                                void run(() =>
                                  post(`/api/tenant/boqs/${c.boqId}/lines/${l.lineId}/sor`, {
                                    sorItemId: s.id,
                                  }),
                                ).then(() => setCite(null))
                              }
                            >
                              {s.code} · {s.description.slice(0, 80)} · {s.unit} ·{' '}
                              {formatInr(s.rate)} ({s.book})
                            </button>
                          ))}
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          {l.sorCode ? (
                            <Badge tone="neutral">{l.sorCode}</Badge>
                          ) : (
                            <span className="text-fg-muted">—</span>
                          )}
                          {canEdit && (
                            <Button
                              variant="ghost"
                              onClick={() => setCite({ lineId: l.lineId, q: '' })}
                            >
                              {l.sorCode ? 'Change' : 'Cite'}
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
      {c && c.bidders.length > 0 && (
        <Card title="Item-wise comparative">
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Item</th>
                {c.bidders.map((b) => (
                  <th key={b.key} className="text-right">
                    {b.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody aria-label="Item-wise comparative">
              {c.lines.map((l) => (
                <tr key={l.lineKey}>
                  <td>
                    {l.code} {l.description}
                  </td>
                  {c.bidders.map((b) => (
                    <td
                      key={b.key}
                      className={`text-right tabular-nums ${l.rates[b.key] && Number(l.rates[b.key]) === Number(l.lowest) ? 'font-semibold text-success' : ''}`}
                    >
                      {l.rates[b.key] ? formatInr(l.rates[b.key]!) : ''}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="font-semibold">
                <td>Total</td>
                {c.bidders.map((b) => (
                  <td key={b.key} className="text-right tabular-nums">
                    {formatInr(b.total)} {b.rank ? `(L${b.rank})` : '(incomplete)'}
                  </td>
                ))}
              </tr>
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
