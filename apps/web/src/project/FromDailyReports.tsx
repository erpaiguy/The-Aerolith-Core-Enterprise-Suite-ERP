// Daily reports into the measurement book (docs/wave7-plan.md step 7c.1): the month's quantities the site reported
// against contract BOQ items, less what the book already has; reviewed line by line and accepted into the book.
import { Alert, Button, Card, EmptyState, Input, Table, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';
import { numberLocale } from '../lib/locale';

interface Proposal {
  month: string;
  bookOn: string;
  lines: {
    boqId: string;
    boq: string;
    lineKey: string;
    code: string | null;
    description: string;
    unit: string | null;
    contractQty: string | null;
    reported: string;
    reports: number;
    measured: string;
    proposed: string;
  }[];
  mayAccept: boolean;
}
const n = (v: string | null) =>
  v === null ? '-' : Number(v).toLocaleString(numberLocale(), { maximumFractionDigits: 3 });
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

export function FromDailyReports({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(lastMonth());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = ['mb-proposal', projectId, month];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Proposal>(`/api/tenant/projects/${projectId}/mb-proposal?month=${month}`),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const open = q.data?.lines.filter((l) => Number(l.proposed) > 0) ?? [];
  const accept = async () => {
    setError(null);
    setDone(null);
    const lines = open
      .map((l) => ({
        boqId: l.boqId,
        lineKey: l.lineKey,
        qty: (qty[l.lineKey] ?? l.proposed).trim(),
      }))
      .filter((l) => Number(l.qty) > 0);
    try {
      const next = await api.request<Proposal>(`/api/tenant/projects/${projectId}/mb-proposal`, {
        method: 'POST',
        body: { month, lines },
      });
      qc.setQueryData(key, next);
      toast.success(`Measurement book: ${lines.length} item${lines.length === 1 ? '' : 's'} added`);
      setQty({});
      setDone(
        `${lines.length} item${lines.length === 1 ? '' : 's'} put in the book on ${shortDate(next.bookOn)}.`,
      );
      void qc.invalidateQueries({ queryKey: ['project-progress', projectId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="From the daily reports"
      actions={
        <Input
          type="month"
          aria-label="Month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setQty({});
            setDone(null);
          }}
        />
      }
    >
      {q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : !q.data ? null : q.data.lines.length === 0 ? (
        <EmptyState title="No submitted daily report this month gives a quantity against a BOQ item.">
          Daily reports that record work done against BOQ items show here, ready for the book.
        </EmptyState>
      ) : (
        <>
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Reported</th>
                <th className="text-right">In the book</th>
                <th className="text-right">To put in</th>
              </tr>
            </thead>
            <tbody aria-label="Proposed quantities">
              {q.data.lines.map((l) => (
                <tr key={l.lineKey}>
                  <td>
                    <span className="font-mono text-xs">{l.code}</span> {l.description}
                    <div className="text-xs text-fg-muted">
                      {l.boq} · {l.reports} report{l.reports === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td className="text-right">
                    {n(l.reported)} {l.unit}
                  </td>
                  <td className="text-right">{n(l.measured)}</td>
                  <td className="text-right">
                    {Number(l.proposed) > 0 && q.data.mayAccept ? (
                      <Input
                        aria-label={`Quantity, ${l.code ?? l.description}`}
                        className="w-28 text-right"
                        inputMode="decimal"
                        value={qty[l.lineKey] ?? l.proposed.replace(/\.?0+$/, '')}
                        onChange={(e) => setQty({ ...qty, [l.lineKey]: e.target.value })}
                      />
                    ) : (
                      n(l.proposed)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {done ? <Alert tone="success">{done}</Alert> : null}
          {open.length > 0 && q.data.mayAccept ? (
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" onClick={() => void accept()}>
                Put in the book
              </Button>
              <span className="text-xs text-fg-muted">
                Dated {shortDate(q.data.bookOn)}. Check each figure against the site first.
              </span>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
