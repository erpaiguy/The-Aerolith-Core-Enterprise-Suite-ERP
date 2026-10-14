// Search everything (docs/wave7-plan.md step 7a.6): Ctrl+K (or the header's Search) opens one box over the screens in
// the menu and the records the person may see: projects, tenders, parties, employees and document numbers.
import { Spinner } from '@aerolith/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

interface Hit {
  kind: string;
  id: string;
  label: string;
  detail: string | null;
  projectId: string | null;
}
export interface ScreenEntry {
  label: string;
  to: string;
  search?: Record<string, string> | undefined;
  /** The menu group it sits in, shown beside it. */
  where: string;
}
interface Target {
  key: string;
  kind: string;
  label: string;
  detail: string | null;
  to: string;
  search?: Record<string, string> | undefined;
}

const KIND: Record<string, string> = {
  screen: 'Screen',
  project: 'Project',
  tender: 'Tender',
  party: 'Party',
  employee: 'Employee',
  requisition: 'Requisition',
  order: 'Order',
  receipt: 'Goods receipt',
  issue: 'Stock issue',
  rfi: 'RFI',
  ncr: 'NCR',
  rfq: 'Enquiry',
  voucher: 'Voucher',
  'vendor-bill': 'Supplier bill',
};

/** Where a record opens. */
function target(h: Hit): Pick<Target, 'to' | 'search'> {
  const on = h.projectId ? { project: h.projectId } : undefined;
  switch (h.kind) {
    case 'project':
      return { to: `/projects/${h.id}` };
    case 'tender':
      return { to: `/tenders/${h.id}` };
    case 'party':
      return { to: '/clients' };
    case 'employee':
      return { to: `/hr/employees/${h.id}` };
    case 'requisition':
      return { to: `/requisitions/${h.id}` };
    case 'order':
      return { to: `/orders/${h.id}` };
    case 'receipt':
      return { to: `/receipts/${h.id}` };
    case 'issue':
      return { to: `/issues/${h.id}` };
    case 'rfi':
      return { to: '/transmittals', search: on };
    case 'ncr':
      return { to: '/quality', search: on };
    case 'rfq':
      return { to: `/rfqs/${h.id}` };
    case 'voucher':
      return { to: `/accounts/vouchers/${h.id}` };
    default:
      return { to: `/accounts/vendor-bills/${h.id}` };
  }
}

export function SearchPalette({ screens }: { screens: ScreenEntry[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
        title="Search everything (Ctrl+K)"
      >
        <Search className="size-4" aria-hidden /> Search
        <kbd className="ml-1 hidden rounded border border-line px-1 text-[10px] text-fg-subtle sm:inline">
          Ctrl K
        </kbd>
      </button>
      {open ? <Palette screens={screens} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Palette({ screens, onClose }: { screens: ScreenEntry[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const q = useDeferredValue(text.trim());
  const records = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.request<{ hits: Hit[] }>(`/api/tenant/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
  const lower = q.toLowerCase();
  const results: Target[] = q
    ? [
        ...screens
          .filter((s) => s.label.toLowerCase().includes(lower))
          .slice(0, 6)
          .map((s) => ({
            key: `screen:${s.to}:${JSON.stringify(s.search ?? {})}`,
            kind: 'screen',
            label: s.label,
            detail: s.where,
            to: s.to,
            search: s.search,
          })),
        ...(q.length >= 2 ? (records.data?.hits ?? []) : []).map((h) => ({
          key: `${h.kind}:${h.id}`,
          kind: h.kind,
          label: h.label,
          detail: h.detail,
          ...target(h),
        })),
      ]
    : [];
  useEffect(() => setActive(0), [q]);
  const go = (t: Target) => {
    onClose();
    void navigate({ to: t.to, ...(t.search ? { search: t.search } : {}) } as never);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Search"
        aria-modal="true"
        className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-fg-muted" aria-hidden />
          <input
            ref={input}
            aria-label="Search everything"
            placeholder="Screens, projects, tenders, parties, numbers…"
            className="w-full bg-transparent py-3 text-sm outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                go(results[active]);
              }
            }}
          />
          {records.isFetching ? <Spinner /> : null}
        </div>
        <ul aria-label="Results" className="max-h-[60vh] overflow-y-auto p-1">
          {results.map((r, i) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => go(r)}
                onMouseEnter={() => setActive(i)}
                aria-current={i === active ? 'true' : undefined}
                className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm ${i === active ? 'bg-surface-2' : ''}`}
              >
                <span className="w-24 shrink-0 text-xs text-fg-subtle">
                  {KIND[r.kind] ?? r.kind}
                </span>
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.detail ? (
                  <span className="max-w-[40%] truncate text-xs text-fg-muted">{r.detail}</span>
                ) : null}
              </button>
            </li>
          ))}
          {q && results.length === 0 && !records.isFetching ? (
            <li className="px-3 py-6 text-center text-sm text-fg-muted">
              {q.length < 2 ? 'Type one more letter.' : 'Nothing found.'}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
