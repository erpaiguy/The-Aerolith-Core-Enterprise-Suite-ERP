// Process flows (docs/wave9-plan.md step 9a.7): a strip of the stages a document moves through — where it stands, and
// the documents before and after it that the person may open. Each stage says in words whether it is done, where
// things stand now, not yet, or does not apply, so colour is never the only sign.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Circle, CircleDot, Minus } from 'lucide-react';
import { api } from '../../api/client';
import { useT } from '../../i18n/i18n';
import { PURCHASE_COUNT, type FlowStep, type StepState } from './flows';

const STATE_WORD: Record<StepState, string> = {
  done: 'Done',
  current: 'Now',
  todo: 'Not yet',
  na: 'Does not apply',
};
const ICON: Record<StepState, typeof Check> = {
  done: Check,
  current: CircleDot,
  todo: Circle,
  na: Minus,
};
const ICON_CLASS: Record<StepState, string> = {
  done: 'border-success text-success',
  current: 'border-accent bg-accent text-accent-fg',
  todo: 'border-line-strong text-fg-subtle',
  na: 'border-dashed border-line text-fg-subtle',
};
/** At most this many documents are listed at a stage; the rest are counted. */
const SHOWN = 4;

export function FlowStrip({ steps }: { steps: FlowStep[] }) {
  const t = useT();
  return (
    <div
      className="rounded-md border border-line bg-surface px-3 py-2.5 print:hidden"
      data-testid="flow-strip"
    >
      <ol aria-label={t('Where this stands')} className="flex flex-wrap gap-x-1 gap-y-3">
        {steps.map((s, i) => {
          const Icon = ICON[s.state];
          const total = s.docs.length + (s.hidden ?? 0);
          const more = s.docs.length - SHOWN;
          return (
            <li
              key={s.key}
              aria-current={s.state === 'current' ? 'step' : undefined}
              data-state={s.state}
              className="flex min-w-36 flex-1 items-start gap-1"
            >
              <span
                className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border ${ICON_CLASS[s.state]}`}
                aria-hidden
              >
                <Icon className="size-3" />
              </span>
              <div className="min-w-0 flex-1 px-1">
                <div
                  className={`text-sm ${s.state === 'current' ? 'font-semibold text-fg' : s.state === 'na' ? 'text-fg-muted' : 'font-medium text-fg'}`}
                >
                  {t(s.label)}
                </div>
                <div className="text-xs text-fg-muted">
                  {t(STATE_WORD[s.state])}
                  {s.here && ` · ${t('this page')}`}
                  {total > 1 && s.count && ` · ${t(s.count, { n: total })}`}
                  {s.note && ` · ${s.note}`}
                </div>
                {(s.docs.length > 0 || (s.hidden ?? 0) > 0) && (
                  <ul className="mt-0.5 space-y-0.5 text-xs">
                    {s.docs.slice(0, SHOWN).map((d) => (
                      <li key={d.id} className="truncate">
                        {d.href && !d.here ? (
                          <Link to={d.href} className="font-mono text-accent hover:underline">
                            {d.number}
                          </Link>
                        ) : (
                          <span className="font-mono">{d.number}</span>
                        )}
                      </li>
                    ))}
                    {more > 0 && (
                      <li className="text-fg-muted">{t('and {n} more', { n: more })}</li>
                    )}
                    {(s.hidden ?? 0) > 0 && (
                      <li className="text-fg-muted">
                        {t('{n} you cannot open', { n: s.hidden ?? 0 })}
                      </li>
                    )}
                  </ul>
                )}
              </div>
              {i < steps.length - 1 && (
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type PurchaseFlowKind = 'requisition' | 'order' | 'receipt' | 'bill';

/**
 * A purchase's strip (requisition → order → receipt → bill → payment) for one of its documents, from the server.
 * `stamp` changes when the page's document does, so the strip follows it. Shows nothing while loading or on an error:
 * the page itself still works.
 */
export function PurchaseFlow({
  kind,
  id,
  stamp,
}: {
  kind: PurchaseFlowKind;
  id: string;
  stamp?: string | number;
}) {
  const q = useQuery({
    queryKey: ['flow', 'purchase', kind, id, stamp ?? null],
    queryFn: () => api.request<{ steps: FlowStep[] }>(`/api/tenant/flows/purchase/${kind}/${id}`),
  });
  if (!q.data) return null;
  return <FlowStrip steps={q.data.steps.map((s) => ({ ...s, count: PURCHASE_COUNT[s.key] }))} />;
}
