// Menus and bars (docs/wave9-plan.md step 9a.5): a person's favourite and recent pages at the top of the menu, a star
// to keep the page one is on, and a status bar along the bottom (company, financial year, connection and what is
// waiting to be sent, the version, and a new release when there is one).
import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock, Star, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { usePref } from '../../lib/prefs';
import { load, save } from '../../lib/storage';
import { usePending } from '../../offline';
import { desktop } from '../../platform';
import { useSession } from '../../session/session';

export interface PageRef {
  path: string;
  title: string;
}

const RECENT_MAX = 8;

/** The page's own title: its heading, or the last part of its address. */
function titleOfPage(path: string): string {
  const h1 = document.querySelector('main h1')?.textContent?.trim();
  if (h1) return h1.slice(0, 80);
  const last = path.split('/').filter(Boolean).at(-1) ?? 'Home';
  return last.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Remembers the pages a person opens, newest first (a moment after arriving, once the heading is there). */
export function useRecordRecent() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [recent, setRecent] = usePref<PageRef[]>('nav.recent', []);
  useEffect(() => {
    if (path === '/') return;
    const t = setTimeout(() => {
      const entry = { path, title: titleOfPage(path) };
      const rest = recent.filter((r) => r.path !== path);
      if (recent[0]?.path === path && recent[0].title === entry.title) return;
      setRecent([entry, ...rest].slice(0, RECENT_MAX));
    }, 1_200);
    return () => clearTimeout(t);
    // Only a new page counts; `recent` changing is our own write.
  }, [path]);
}

/** The star beside the page: keeps this page among the person's favourites. */
export function FavouriteToggle() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [favs, setFavs] = usePref<PageRef[]>('nav.favourites', []);
  const on = favs.some((f) => f.path === path);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Take this page out of favourites' : 'Keep this page in favourites'}
      title={on ? 'Take out of favourites' : 'Keep in favourites'}
      onClick={() =>
        setFavs(
          on
            ? favs.filter((f) => f.path !== path)
            : [...favs, { path, title: titleOfPage(path) }].slice(-20),
        )
      }
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
    >
      <Star className={`size-4 ${on ? 'fill-warning text-warning' : ''}`} aria-hidden />
    </button>
  );
}

function PageList({
  label,
  icon,
  pages,
  folds,
}: {
  label: string;
  icon: ReactNode;
  pages: PageRef[];
  /** Folded until opened (and remembered on this device), so the menu stays short. */
  folds?: string;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(() => !folds || load(folds) === 'open');
  if (!pages.length) return null;
  const heading = (
    <>
      {icon}
      {label}
    </>
  );
  return (
    <nav aria-label={label} className="mb-2">
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            save(folds, open ? null : 'open');
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 pt-1 pb-1 text-left text-xs font-medium text-fg-muted hover:bg-surface-2"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1 text-xs font-medium text-fg-muted">
          {heading}
        </div>
      )}
      {open && (
        <ul className="space-y-0.5">
          {pages.map((p) => (
            <li key={p.path}>
              <Link
                to={p.path}
                aria-current={p.path === path ? 'page' : undefined}
                className={`block truncate rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-2 ${
                  p.path === path ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted'
                }`}
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Favourites, then the five most recent pages that are not already favourites. */
export function PersonalNav() {
  const [favs] = usePref<PageRef[]>('nav.favourites', []);
  const [recent] = usePref<PageRef[]>('nav.recent', []);
  const fav = new Set(favs.map((f) => f.path));
  return (
    <>
      <PageList label="Favourites" icon={<Star className="size-3.5" aria-hidden />} pages={favs} />
      <PageList
        label="Recent"
        icon={<Clock className="size-3.5" aria-hidden />}
        pages={recent.filter((r) => !fav.has(r.path)).slice(0, 5)}
        folds="aerolith.nav.recent"
      />
    </>
  );
}

/** Indian financial year of a date: April to March, written 2026-27. */
export function financialYear(d = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export const appVersion = () => desktop()?.appVersion || __APP_VERSION__;

/** Along the bottom of every page. `release` is the new-release notice, when there is one (step 9b.4). */
export function StatusBar({ release }: { release?: ReactNode }) {
  const session = useSession();
  const online = useOnline();
  const pending = usePending().filter((p) => !p.userId || p.userId === session.user?.id);
  const company = useQuery({
    queryKey: ['welcome'],
    queryFn: () => api.request<{ company: string | null }>('/api/auth/welcome'),
    // The frame can be drawn for a moment before the redirect to sign-in; nobody to ask about yet.
    enabled: session.status === 'signed_in',
    staleTime: Infinity,
  });
  return (
    <footer className="print:hidden flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface px-4 py-1.5 text-xs text-fg-muted md:px-6">
      {company.data?.company && (
        <span className="truncate font-medium">{company.data.company}</span>
      )}
      <span>FY {financialYear()}</span>
      <span className="inline-flex items-center gap-1" role="status">
        {online ? (
          <Wifi className="size-3.5 text-success" aria-hidden />
        ) : (
          <WifiOff className="size-3.5 text-warning" aria-hidden />
        )}
        {online ? 'Online' : 'No signal: entries are kept on this device'}
        {pending.length > 0 && (
          <Link to="/outbox" className="ml-1 underline">
            {pending.length} waiting to send
          </Link>
        )}
      </span>
      <span className="ml-auto">Version {appVersion()}</span>
      {release}
    </footer>
  );
}
