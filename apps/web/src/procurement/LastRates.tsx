// What each material was last bought at (docs/wave8-plan.md step 8e.4), shown where it is being bought: on
// requisitions, comparative statements and orders. Shown only to those who buy (the server refuses the rest).
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface History {
  resourceId: string;
  last: {
    on: string;
    rate: string;
    unit: string;
    party: string;
    order: string;
    project: string;
  } | null;
  previousRate: string | null;
  changePct: number | null;
  trend: { month: string; rate: string }[];
}
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function useLastRates(resourceIds: (string | null | undefined)[]) {
  const ids = [...new Set(resourceIds.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ['purchase-history', ids],
    queryFn: () =>
      api.request<History[]>(
        `/api/tenant/procurement/purchase-history?resourceIds=${ids.join(',')}`,
      ),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 60_000,
  });
}

/** One line per material bought before: the last rate, from whom and when, and the change on the one before. */
export function LastRates({
  resourceIds,
  names,
}: {
  resourceIds: (string | null | undefined)[];
  names?: Record<string, string>;
}) {
  const q = useLastRates(resourceIds);
  const rows = (q.data ?? []).filter((h) => h.last);
  if (!rows.length) return null;
  return (
    <div className="mt-3 rounded-md bg-surface-2 p-3 text-sm" aria-label="Last purchase rates">
      <div className="mb-1 font-medium">Last bought at</div>
      <ul className="space-y-0.5">
        {rows.map((h) => (
          <li key={h.resourceId}>
            {names?.[h.resourceId] ? `${names[h.resourceId]}: ` : ''}
            {inr(h.last!.rate)}/{h.last!.unit} from {h.last!.party} on {h.last!.on} ({h.last!.order}
            )
            {h.changePct !== null && (
              <span className={h.changePct > 0 ? 'text-danger' : 'text-success'}>
                {' '}
                {h.changePct > 0 ? '▲' : h.changePct < 0 ? '▼' : ''}
                {Math.abs(h.changePct)}% on the time before
              </span>
            )}
            {h.trend.length > 1 && (
              <span className="text-fg-muted">
                {' '}
                · past year {h.trend.map((t) => inr(t.rate)).join(' → ')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
