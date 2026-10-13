import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  Banknote,
  Bell,
  ClipboardCheck,
  Fingerprint,
  HardHat,
  IdCard,
  ChartColumn,
  LayoutDashboard,
  LayoutTemplate,
  Settings2,
  ShieldCheck,
  Gauge,
  ArrowLeftRight,
  TrendingUp,
  FilePlus2,
  Boxes,
  BriefcaseBusiness,
  Calculator,
  BookOpen,
  CalendarCheck,
  CheckCheck,
  HandCoins,
  Landmark,
  Percent,
  ListTree,
  ReceiptText,
  Scale,
  TriangleAlert,
  Fan,
  FileCheck2,
  Send,
  Signature,
  Handshake,
  Inbox as InboxIcon,
  Plug,
  Home,
  ChartPie,
  MailCheck,
  LayoutGrid,
  ClipboardList,
  ListChecks,
  PackageCheck,
  ShoppingCart,
  Building2,
  Construction,
  Truck,
  FileBarChart,
  Contact,
  FileStack,
  KeyRound,
  Menu,
  LogOut,
  ScrollText,
  Tags,
  Users,
  UsersRound,
  Wallet,
  Warehouse,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { usePermission } from '../session/permissions';
import type { Inbox } from '../api/types';
import { daysUntil, formatDate } from '../lib/format';
import { useSession } from '../session/session';
import { usePending } from '../offline';
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
  const mayBooks = usePermission('accounts.view');
  const mayPortals = usePermission('portal.manage');
  const mayPeople = usePermission('hr.view');
  const mayMark = usePermission('attendance.mark');
  const mayPayroll = usePermission('payroll.run');
  const mayLabour = usePermission('labour.manage');
  const signedIn = session.status === 'signed_in';
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api.request<Inbox>('/api/tenant/inbox'),
    refetchInterval: 60_000,
    enabled: signedIn,
  });
  // On a phone the menu is folded away behind a button, and folds again on every page change.
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useRouterState({ select: (r) => r.location.pathname });
  useEffect(() => setMenuOpen(false), [path]);

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
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">Aerolith Core</div>
              <div className="truncate text-xs text-fg-muted">
                {session.entitlement?.tier === 'trial' ? 'Trial' : 'Licensed'}
              </div>
            </div>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-2.5 py-2 text-sm text-fg-muted hover:bg-surface-2 md:hidden"
              aria-expanded={menuOpen}
              aria-controls="main-menu"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Menu className="size-5" aria-hidden /> Menu
            </button>
          </div>
          <nav
            className={`${menuOpen ? 'block' : 'hidden'} space-y-0.5 px-2 pb-3 md:block`}
            aria-label="Main"
            id="main-menu"
          >
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
                <NavItem to="/settings/companies" icon={<Landmark className="size-4" />}>
                  Companies
                </NavItem>
                <NavItem to="/settings/integrations" icon={<Plug className="size-4" />}>
                  Integrations
                </NavItem>
              </>
            )}
            <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Pre-construction
            </div>
            <NavItem to="/dashboards/tender" icon={<LayoutDashboard className="size-4" />}>
              Dashboards
            </NavItem>
            <NavItem to="/crm" icon={<Handshake className="size-4" />}>
              CRM
            </NavItem>
            {mayPortals && (
              <>
                <NavItem to="/portal-users" icon={<UsersRound className="size-4" />}>
                  Portal users
                </NavItem>
                <NavItem to="/portal-submissions" icon={<InboxIcon className="size-4" />}>
                  Portal submissions
                </NavItem>
              </>
            )}
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
            <NavItem to="/reports/builder" icon={<ChartPie className="size-4" />}>
              Report builder
            </NavItem>
            <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Construction
            </div>
            <NavItem to="/sales" icon={<Home className="size-4" />}>
              Sales and RERA
            </NavItem>
            <NavItem to="/projects" icon={<Building2 className="size-4" />}>
              Projects
            </NavItem>
            <NavItem to="/portfolio" icon={<LayoutGrid className="size-4" />}>
              Portfolio
            </NavItem>
            <NavItem to="/monthly-review" icon={<CalendarCheck className="size-4" />}>
              Monthly review
            </NavItem>
            <NavItem to="/cost-control" icon={<Gauge className="size-4" />}>
              Cost control
            </NavItem>
            {mayBooks && (
              <NavItem to="/cash-flow" icon={<ArrowLeftRight className="size-4" />}>
                Cash flow
              </NavItem>
            )}
            <NavItem to="/earned-value" icon={<TrendingUp className="size-4" />}>
              Earned value
            </NavItem>
            <NavItem to="/variations" icon={<FilePlus2 className="size-4" />}>
              Variations
            </NavItem>
            <NavItem to="/contracts" icon={<Scale className="size-4" />}>
              Contracts and claims
            </NavItem>
            <NavItem to="/risks" icon={<TriangleAlert className="size-4" />}>
              Risk register
            </NavItem>
            <NavItem to="/mep" icon={<Fan className="size-4" />}>
              MEP
            </NavItem>
            <NavItem
              to="/reviews"
              icon={<FileCheck2 className="size-4" />}
              badge={inbox.data?.pending.reviews}
            >
              Reviews
            </NavItem>
            <NavItem to="/transmittals" icon={<Send className="size-4" />}>
              Transmittals and RFIs
            </NavItem>
            <NavItem
              to="/sign-offs"
              icon={<Signature className="size-4" />}
              badge={inbox.data?.pending.signoffs}
            >
              Sign-offs
            </NavItem>
            <NavItem
              to="/drawing-receipts"
              icon={<MailCheck className="size-4" />}
              badge={inbox.data?.pending.receipts}
            >
              Drawing receipts
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
            <NavItem to="/stores" icon={<Warehouse className="size-4" />}>
              Stores
            </NavItem>
            <NavItem to="/procurement-reports" icon={<ClipboardList className="size-4" />}>
              Procurement reports
            </NavItem>
            <NavItem to="/quality" icon={<BadgeCheck className="size-4" />}>
              Quality
            </NavItem>
            <NavItem to="/safety" icon={<ShieldCheck className="size-4" />}>
              Safety
            </NavItem>
            <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              People
            </div>
            <NavItem to="/hr/me" icon={<Fingerprint className="size-4" />}>
              My attendance
            </NavItem>
            {mayMark && (
              <NavItem to="/hr/register" icon={<ClipboardCheck className="size-4" />}>
                Site attendance
              </NavItem>
            )}
            {mayPeople && (
              <NavItem to="/hr" icon={<IdCard className="size-4" />}>
                Employees
              </NavItem>
            )}
            {mayPayroll && (
              <NavItem to="/payroll" icon={<Banknote className="size-4" />}>
                Payroll
              </NavItem>
            )}
            {mayLabour && (
              <NavItem to="/labour" icon={<HardHat className="size-4" />}>
                Contract labour
              </NavItem>
            )}
            {(mayLabour || mayMark) && (
              <NavItem to="/labour/muster" icon={<UsersRound className="size-4" />}>
                Labour muster
              </NavItem>
            )}
            {mayBooks && (
              <>
                <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                  Accounts
                </div>
                <NavItem to="/accounts/vouchers" icon={<ReceiptText className="size-4" />}>
                  Vouchers
                </NavItem>
                <NavItem to="/accounts/receivables" icon={<HandCoins className="size-4" />}>
                  Receivables
                </NavItem>
                <NavItem to="/accounts/payables" icon={<Wallet className="size-4" />}>
                  Payables
                </NavItem>
                <NavItem to="/accounts/gst" icon={<Landmark className="size-4" />}>
                  GST
                </NavItem>
                <NavItem to="/accounts/tds" icon={<Percent className="size-4" />}>
                  TDS
                </NavItem>
                <NavItem to="/accounts/bank" icon={<Building2 className="size-4" />}>
                  Bank
                </NavItem>
                <NavItem to="/equipment" icon={<Construction className="size-4" />}>
                  Equipment
                </NavItem>
                <NavItem to="/accounts/assets" icon={<Truck className="size-4" />}>
                  Fixed assets
                </NavItem>
                <NavItem to="/accounts/statements" icon={<FileBarChart className="size-4" />}>
                  Statements
                </NavItem>
                <NavItem to="/accounts/trial-balance" icon={<Scale className="size-4" />}>
                  Trial balance
                </NavItem>
                <NavItem to="/accounts/day-book" icon={<BookOpen className="size-4" />}>
                  Day book
                </NavItem>
                <NavItem to="/accounts/chart" icon={<ListTree className="size-4" />}>
                  Chart of accounts
                </NavItem>
                <NavItem to="/accounts/setup" icon={<CalendarCheck className="size-4" />}>
                  Books setup
                </NavItem>
              </>
            )}
          </nav>
          <div className={`${menuOpen ? 'block' : 'hidden'} px-4 pb-4 md:block`}>
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
              <OutboxChip />
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

/** Forms waiting on this phone for signal (docs/wave6-plan.md step 4); hidden when there are none. */
function OutboxChip() {
  const pending = usePending();
  if (!pending.length) return null;
  const refused = pending.some((p) => p.error);
  return (
    <Link
      to="/outbox"
      className="rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-2"
      aria-label={`Outbox, ${pending.length} waiting`}
    >
      <Badge tone={refused ? 'danger' : 'warning'}>Outbox {pending.length}</Badge>
    </Link>
  );
}
