import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  ChartColumn,
  LayoutDashboard,
  LayoutTemplate,
  Settings2,
  Boxes,
  BriefcaseBusiness,
  Calculator,
  CheckCheck,
  ListChecks,
  PackageCheck,
  ShoppingCart,
  Building2,
  Contact,
  FileStack,
  KeyRound,
  LogOut,
  ScrollText,
  Tags,
  Users,
  Warehouse,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { Inbox } from '../api/types';
import { daysUntil, formatDate } from '../lib/format';
import { useSession } from '../session/session';
import { Badge } from '@aerolith/ui';

function NavItem({
  to,
  icon,
  children,
  badge,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  badge?: number | undefined;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
      activeProps={{ className: 'bg-surface-2 text-fg font-medium' }}
      activeOptions={{ exact: to === '/' }}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {badge ? <Badge tone="accent">{badge}</Badge> : null}
    </Link>
  );
}

function Upcoming({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-fg-subtle"
      title="Arrives in Wave 1"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <span className="text-[10px] uppercase tracking-wide">Soon</span>
    </div>
  );
}

/** Licence banner: trial countdown, grace period, read-only. */
function LicenceBanner() {
  const { licence, entitlement } = useSession();
  if (!licence || !entitlement) return null;
  const days = daysUntil(entitlement.ends);
  if (licence.state === 'grace') {
    return (
      <div className="bg-warning/15 px-4 py-2 text-sm text-fg">
        Your licence ended on {formatDate(entitlement.ends)}. Renew now: the app becomes read-only
        after the grace period.
      </div>
    );
  }
  if (licence.state === 'read_only') {
    return (
      <div className="bg-danger/15 px-4 py-2 text-sm text-fg">
        Your licence has ended. You can view and export data, but not change it.
      </div>
    );
  }
  if (entitlement.tier === 'trial' && days <= 14) {
    return (
      <div className="bg-info/10 px-4 py-2 text-sm text-fg">
        Trial ends {days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`} (
        {formatDate(entitlement.ends)}).
      </div>
    );
  }
  return null;
}

export function AppShell() {
  const session = useSession();
  const isAdmin = session.user?.role === 'admin';
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api.request<Inbox>('/api/tenant/inbox'),
    refetchInterval: 60_000,
  });

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <div className="print:hidden">
        <LicenceBanner />
      </div>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="print:hidden border-b border-line bg-surface md:w-60 md:shrink-0 md:border-b-0 md:border-r">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex size-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
              A
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Aerolith Core</div>
              <div className="truncate text-xs text-fg-muted">
                {session.entitlement?.tier === 'trial' ? 'Trial' : 'Licensed'}
              </div>
            </div>
          </div>
          <nav className="space-y-0.5 px-2 pb-3" aria-label="Main">
            <NavItem to="/" icon={<Bell className="size-4" />} badge={inbox.data?.unread}>
              Home
            </NavItem>
            <NavItem
              to="/approvals"
              icon={<CheckCheck className="size-4" />}
              badge={inbox.data?.pending.approvals}
            >
              Approvals
            </NavItem>
            {isAdmin && (
              <>
                <NavItem to="/users" icon={<Users className="size-4" />}>
                  Users
                </NavItem>
                <NavItem
                  to="/password-resets"
                  icon={<KeyRound className="size-4" />}
                  badge={inbox.data?.pending.passwordResets}
                >
                  Reset requests
                </NavItem>
                <NavItem to="/settings/tenders" icon={<Settings2 className="size-4" />}>
                  Tender settings
                </NavItem>
                <NavItem to="/settings/approvals" icon={<ListChecks className="size-4" />}>
                  Approval rules
                </NavItem>
              </>
            )}
            <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Pre-construction
            </div>
            <NavItem to="/dashboards/tender" icon={<LayoutDashboard className="size-4" />}>
              Dashboards
            </NavItem>
            <NavItem to="/tenders" icon={<ScrollText className="size-4" />}>
              Tenders
            </NavItem>
            <NavItem to="/clients" icon={<Contact className="size-4" />}>
              Clients
            </NavItem>
            <NavItem to="/resources" icon={<Boxes className="size-4" />}>
              Resources
            </NavItem>
            <NavItem to="/rate-analyses" icon={<Calculator className="size-4" />}>
              Rate analyses
            </NavItem>
            <NavItem to="/boq-templates" icon={<LayoutTemplate className="size-4" />}>
              BOQ templates
            </NavItem>
            <NavItem to="/documents" icon={<FileStack className="size-4" />}>
              Documents
            </NavItem>
            <NavItem to="/reports" icon={<ChartColumn className="size-4" />}>
              Reports
            </NavItem>
            <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Construction
            </div>
            <NavItem to="/projects" icon={<Building2 className="size-4" />}>
              Projects
            </NavItem>
            <NavItem to="/cost-codes" icon={<Tags className="size-4" />}>
              Cost codes
            </NavItem>
            <NavItem to="/requisitions" icon={<ShoppingCart className="size-4" />}>
              Requisitions
            </NavItem>
            <NavItem to="/orders" icon={<BriefcaseBusiness className="size-4" />}>
              Orders
            </NavItem>
            <NavItem to="/receipts" icon={<PackageCheck className="size-4" />}>
              Goods receipts
            </NavItem>
            <Upcoming icon={<Warehouse className="size-4" />}>Stores</Upcoming>
          </nav>
          <div className="px-4 pb-4">
            <Link to="/licences" className="text-xs text-fg-subtle hover:underline">
              Third-party licences
            </Link>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="print:hidden flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
            <div className="min-w-0 text-sm">
              <span className="font-medium">{session.user?.displayName}</span>{' '}
              <Badge>{session.user?.role}</Badge>
            </div>
            <div className="flex items-center gap-1">
              <Link
                to="/account/password"
                className="rounded-md px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
              >
                Account
              </Link>
              <button
                type="button"
                onClick={() => void session.signOut()}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
              >
                <LogOut className="size-4" aria-hidden /> Sign out
              </button>
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
