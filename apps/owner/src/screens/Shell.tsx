import { Badge } from '@aerolith/ui';
import { Link, Outlet } from '@tanstack/react-router';
import {
  Building2,
  DatabaseZap,
  History,
  LayoutDashboard,
  LogOut,
  Mail,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useSession } from '../session';

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
      activeProps={{ className: 'bg-surface-2 text-fg font-medium' }}
      activeOptions={{ exact: to === '/' }}
    >
      {icon}
      <span className="flex-1">{children}</span>
    </Link>
  );
}

export function Shell() {
  const session = useSession();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas md:flex-row">
      <aside className="border-b border-line bg-surface md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex size-8 items-center justify-center rounded-md bg-fg text-sm font-bold text-canvas">
            A
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Aerolith Core</div>
            <div className="truncate text-xs text-fg-muted">Owner console</div>
          </div>
        </div>
        <nav className="space-y-0.5 px-2 pb-3" aria-label="Main">
          <NavItem to="/" icon={<LayoutDashboard className="size-4" />}>
            Overview
          </NavItem>
          <NavItem to="/tenants" icon={<Building2 className="size-4" />}>
            Tenants
          </NavItem>
          <NavItem to="/email" icon={<Mail className="size-4" />}>
            Email
          </NavItem>
          <NavItem to="/migrations" icon={<DatabaseZap className="size-4" />}>
            Migrations
          </NavItem>
          <NavItem to="/audit" icon={<History className="size-4" />}>
            Audit log
          </NavItem>
          <NavItem to="/account" icon={<UserRound className="size-4" />}>
            Account
          </NavItem>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
          <div className="min-w-0 truncate text-sm">
            <span className="font-medium">{session.operator?.displayName}</span>{' '}
            <Badge tone={session.canWrite ? 'accent' : 'neutral'}>{session.operator?.role}</Badge>
          </div>
          <button
            type="button"
            onClick={() => void session.signOut()}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </header>
        {!session.canWrite && (
          <div className="bg-info/10 px-4 py-2 text-sm md:px-6">
            View only: your role cannot change tenants, licences or settings.
          </div>
        )}
        <main className="flex-1 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Page title row with optional actions on the right. */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      {actions}
    </div>
  );
}

/** Responsive table wrapper: scrolls sideways inside its card instead of widening the page. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm [&_td]:px-5 [&_td]:py-2.5 [&_th]:px-5 [&_th]:pb-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-fg-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line">
        {children}
      </table>
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warning';
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}
