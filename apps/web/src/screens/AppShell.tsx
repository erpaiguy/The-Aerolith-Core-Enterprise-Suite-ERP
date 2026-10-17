import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  ChevronRight,
  Banknote,
  Bell,
  ClipboardCheck,
  Fingerprint,
  HardHat,
  History,
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
  Repeat,
  Scale,
  TriangleAlert,
  Fan,
  FileCheck2,
  Send,
  Signature,
  Handshake,
  Inbox as InboxIcon,
  Plug,
  Plus,
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
  CalendarClock,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { usePermission } from '../session/permissions';
import type { Inbox, ProjectSummary } from '../api/types';
import { daysUntil, formatDate } from '../lib/format';
import { useSession } from '../session/session';
import { usePending } from '../offline';
import { Badge, Select } from '@aerolith/ui';
import { load, save } from '../lib/storage';
import { SearchPalette, type ScreenEntry } from './SearchPalette';
import { useMyWork, workCount } from './MyWork';

function NavItem({
  to,
  icon,
  children,
  badge,
  depth = 0,
  search,
  hash,
  exact,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  badge?: number | undefined;
  depth?: number;
  search?: Record<string, string> | undefined;
  hash?: string | undefined;
  exact?: boolean | undefined;
}) {
  return (
    <Link
      to={to}
      {...(search ? { search } : {})}
      {...(hash ? { hash } : {})}
      className={`flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg ${depth ? 'pl-8' : 'pl-2.5'}`}
      activeProps={{ className: 'bg-surface-2 text-fg font-medium' }}
      activeOptions={{
        exact: exact ?? (to === '/' || to.startsWith('/dashboards/')),
        includeSearch: !!search,
        includeHash: !!hash || !!exact,
      }}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {badge ? <Badge tone="accent">{badge}</Badge> : null}
    </Link>
  );
}

// The menu is a tree: groups (folded unless opened or holding the current page), some with sub-groups, then pages.
interface Page {
  to: string;
  /** Query string for a filtered list (Suppliers: parties of kind vendor). */
  search?: Record<string, string>;
  /** A section of a page (the project workspace's `#boqs`). */
  hash?: string;
  /** Lit only on this very address, not below it. */
  exact?: boolean;
  label: string;
  icon: ReactNode;
  badge?: number | undefined;
  show?: boolean;
}
interface Group {
  group: string;
  icon: ReactNode;
  items: (Page | Group)[];
  /** Other paths that belong here (detail pages reached from a list). */
  also?: string[];
  show?: boolean;
}
const isGroup = (e: Page | Group): e is Group => 'group' in e;
const visible = <T extends Page | Group>(e: T) => e.show !== false;
const OPEN_KEY = 'aerolith.nav.open';

function holds(e: Page | Group, path: string): boolean {
  if (!isGroup(e))
    return e.to === '/' ? path === '/' : path === e.to || path.startsWith(`${e.to}/`);
  return (
    (e.also ?? []).some((p) => path === p || path.startsWith(`${p}/`)) ||
    e.items.some((i) => visible(i) && holds(i, path))
  );
}

function NavGroup({
  g,
  depth,
  open,
  toggle,
}: {
  g: Group;
  depth: number;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  const items = g.items.filter(visible);
  if (!items.length) return null;
  const isOpen = open.has(g.group);
  const badge = items.reduce((n, i) => n + (!isGroup(i) && i.badge ? i.badge : 0), 0);
  return (
    <div data-nav-group={g.group}>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => toggle(g.group)}
        className={`flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2.5 text-left text-sm hover:bg-surface-2 ${
          depth ? 'pl-8 text-fg-muted' : 'pl-2.5 font-medium text-fg'
        }`}
      >
        {g.icon}
        <span className="flex-1">{g.group}</span>
        {!isOpen && badge ? <Badge tone="accent">{badge}</Badge> : null}
        <ChevronRight
          className={`size-3.5 text-fg-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      <div hidden={!isOpen} className={depth ? 'ml-4 border-l border-line pl-1' : 'space-y-0.5'}>
        {items.map((i) =>
          isGroup(i) ? (
            <NavGroup key={i.group} g={i} depth={depth + 1} open={open} toggle={toggle} />
          ) : (
            <NavItem
              key={i.to + JSON.stringify(i.search ?? {}) + (i.hash ?? '')}
              to={i.to}
              search={i.search}
              hash={i.hash}
              exact={i.exact}
              icon={i.icon}
              badge={i.badge}
              depth={depth + 1}
            >
              {i.label}
            </NavItem>
          ),
        )}
      </div>
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project being worked in: a project's own page, or a screen opened on one (`?project=`). */
function currentProject(path: string, search: Record<string, unknown>): string | null {
  const m = /^\/projects\/([0-9a-f-]{36})(\/|$)/.exec(path);
  if (m && UUID.test(m[1]!)) return m[1]!;
  return typeof search.project === 'string' && UUID.test(search.project) ? search.project : null;
}

/** One project's sections, for the workspace (docs/wave7-plan.md step 7a.4). */
function projectSections(id: string): Group[] {
  const home = `/projects/${id}`;
  const on = { project: id };
  return [
    {
      group: 'Plan and progress',
      icon: <ListTree className="size-4" />,
      items: [
        { to: home, exact: true, label: 'Overview', icon: <Building2 className="size-4" /> },
        { to: `${home}/dashboard`, label: 'Dashboard', icon: <Gauge className="size-4" /> },
        { to: home, hash: 'boqs', label: 'BOQs', icon: <ScrollText className="size-4" /> },
        { to: `${home}/wbs`, label: 'WBS', icon: <ListTree className="size-4" /> },
        {
          to: home,
          hash: 'programme',
          label: 'Programme',
          icon: <CalendarCheck className="size-4" />,
        },
        { to: `${home}/macro`, label: 'Macro plan', icon: <LayoutGrid className="size-4" /> },
        { to: `${home}/progress`, label: 'Measurement', icon: <TrendingUp className="size-4" /> },
        {
          to: `${home}/daily-reports`,
          label: 'Daily reports',
          icon: <ClipboardList className="size-4" />,
        },
      ],
    },
    {
      group: 'Buy and store',
      icon: <ShoppingCart className="size-4" />,
      items: [
        {
          to: home,
          hash: 'material-budget',
          label: 'Material budget',
          icon: <Boxes className="size-4" />,
        },
        {
          to: home,
          hash: 'requisitions',
          label: 'Requisitions',
          icon: <ShoppingCart className="size-4" />,
        },
        { to: home, hash: 'enquiries', label: 'Enquiries', icon: <Send className="size-4" /> },
        {
          to: home,
          hash: 'orders',
          label: 'Orders',
          icon: <BriefcaseBusiness className="size-4" />,
        },
        { to: home, hash: 'stores', label: 'Stores', icon: <Warehouse className="size-4" /> },
        {
          to: `${home}/consumption`,
          label: 'Consumption',
          icon: <PackageCheck className="size-4" />,
        },
        {
          to: `${home}/procurement-reports`,
          label: 'Procurement reports',
          icon: <FileBarChart className="size-4" />,
        },
      ],
    },
    {
      group: 'Money and contract',
      icon: <Wallet className="size-4" />,
      items: [
        {
          to: home,
          hash: 'client-bills',
          label: 'Client bills',
          icon: <ReceiptText className="size-4" />,
        },
        {
          to: '/registers/subcontract-bills',
          search: on,
          label: 'Subcontract bills',
          icon: <ReceiptText className="size-4" />,
        },
        { to: `${home}/imprest`, label: 'Site imprest', icon: <Wallet className="size-4" /> },
        {
          to: '/variations',
          search: on,
          label: 'Variations',
          icon: <FilePlus2 className="size-4" />,
        },
        {
          to: '/contracts',
          search: on,
          label: 'Contracts and claims',
          icon: <Scale className="size-4" />,
        },
        { to: '/risks', search: on, label: 'Risks', icon: <TriangleAlert className="size-4" /> },
        { to: '/cost-control', search: on, label: 'Cost', icon: <Gauge className="size-4" /> },
        { to: '/cash-flow', search: on, label: 'Cash flow', icon: <Banknote className="size-4" /> },
      ],
    },
    {
      group: 'Site and documents',
      icon: <HardHat className="size-4" />,
      items: [
        { to: `${home}/meetings`, label: 'Meetings', icon: <Users className="size-4" /> },
        { to: `${home}/letters`, label: 'Correspondence', icon: <MailCheck className="size-4" /> },
        {
          to: `${home}/document-list`,
          label: 'Document list',
          icon: <FileCheck2 className="size-4" />,
        },
        {
          to: `${home}/itp`,
          label: 'Inspection and test plan',
          icon: <ListChecks className="size-4" />,
        },
        { to: '/quality', search: on, label: 'Quality', icon: <BadgeCheck className="size-4" /> },
        { to: '/safety', search: on, label: 'Safety', icon: <ShieldCheck className="size-4" /> },
        {
          to: `${home}/site-walks`,
          label: 'Safety inspections',
          icon: <ClipboardList className="size-4" />,
        },
        {
          to: `${home}/documents`,
          label: 'Documents and drawings',
          icon: <FileStack className="size-4" />,
        },
        {
          to: '/transmittals',
          search: on,
          label: 'Transmittals and RFIs',
          icon: <Send className="size-4" />,
        },
        { to: home, hash: 'sites', label: 'Sites and team', icon: <Users className="size-4" /> },
      ],
    },
  ];
}

/** On a project's pages the menu leads with that project: a picker to switch, and its sections. */
function ProjectWorkspace({
  projectId,
  open,
  toggle,
}: {
  projectId: string;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  const navigate = useNavigate();
  const location = useRouterState({ select: (r) => r.location });
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  // Another project: the same section of it.
  const switchTo = (id: string) => {
    if (!id || id === projectId) return;
    if (location.pathname.startsWith(`/projects/${projectId}`))
      void navigate({
        to: location.pathname.replace(projectId, id),
        hash: location.hash || undefined,
      } as never);
    else
      void navigate({
        to: location.pathname,
        search: { ...(location.search as Record<string, unknown>), project: id },
      } as never);
  };
  return (
    <nav aria-label="Project" className="mb-2 space-y-0.5 border-b border-line pb-2">
      <label className="block px-2.5 pb-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">
        Project
        <Select
          aria-label="Current project"
          className="mt-1 w-full normal-case tracking-normal"
          value={projectId}
          onChange={(e) => switchTo(e.target.value)}
        >
          {(projects.data ?? []).some((p) => p.id === projectId) ? null : (
            <option value={projectId}>This project</option>
          )}
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.number} {p.name}
            </option>
          ))}
        </Select>
      </label>
      {projectSections(projectId).map((g) => (
        <NavGroup key={g.group} g={g} depth={0} open={open} toggle={toggle} />
      ))}
    </nav>
  );
}

/** The header's "New" menu (docs/wave7-plan.md step 7a.5): the common create forms, on the current project. */
function NewMenu({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const mayBooks = usePermission('accounts.view');
  const mayPeople = usePermission('hr.edit');
  const path = useRouterState({ select: (r) => r.location.href });
  useEffect(() => setOpen(false), [path]);
  const on = (key: string) => (projectId ? { new: key, project: projectId } : { new: key });
  const items: {
    label: string;
    to: string;
    search?: Record<string, string>;
    hash?: string;
    show?: boolean;
  }[] = [
    { label: 'Tender', to: '/tenders/new' },
    { label: 'Project', to: '/projects', search: { new: 'project' } },
    { label: 'Party', to: '/clients', search: { new: 'party' } },
    { label: 'Lead', to: '/crm', search: { new: 'lead' } },
    ...(projectId
      ? [
          {
            label: 'Requisition',
            to: `/projects/${projectId}`,
            search: { new: 'requisition' },
            hash: 'requisitions',
          },
        ]
      : []),
    { label: 'RFI', to: '/transmittals', search: on('rfi') },
    { label: 'Variation', to: '/variations', search: on('variation') },
    { label: 'Risk', to: '/risks', search: on('risk') },
    { label: 'Voucher', to: '/accounts/vouchers/new', show: mayBooks },
    { label: 'Supplier bill', to: '/accounts/vendor-bills/new', show: mayBooks },
    { label: 'Client receipt', to: '/accounts/client-receipts/new', show: mayBooks },
    { label: 'Employee', to: '/hr', search: { new: 'employee' }, show: mayPeople },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="new-menu"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
      >
        <Plus className="size-4" aria-hidden /> New
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <ul
            id="new-menu"
            aria-label="Create"
            className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-line bg-surface p-1 shadow-lg"
          >
            {items
              .filter((i) => i.show !== false)
              .map((i) => (
                <li key={i.label}>
                  <Link
                    to={i.to}
                    {...(i.search ? { search: i.search } : {})}
                    {...(i.hash ? { hash: i.hash } : {})}
                    className="block rounded px-3 py-1.5 text-sm hover:bg-surface-2"
                  >
                    {i.label}
                  </Link>
                </li>
              ))}
            {projectId ? null : (
              <li className="px-3 py-1.5 text-xs text-fg-subtle">
                Open a project to raise a requisition there.
              </li>
            )}
          </ul>
        </>
      ) : null}
    </div>
  );
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
  const search = useRouterState({ select: (r) => r.location.search as Record<string, unknown> });
  const projectId = signedIn ? currentProject(path, search) : null;
  useEffect(() => setMenuOpen(false), [path]);
  const pending = inbox.data?.pending;
  const work = useMyWork();

  const menu: Group[] = [
    {
      group: 'Business development',
      icon: <Handshake className="size-4" />,
      items: [
        {
          to: '/dashboards/tender',
          label: 'Bid dashboard',
          icon: <LayoutDashboard className="size-4" />,
        },
        { to: '/crm', label: 'CRM', icon: <Handshake className="size-4" /> },
        { to: '/clients', label: 'Parties', icon: <Contact className="size-4" /> },
        { to: '/sales', label: 'Sales and RERA', icon: <Home className="size-4" /> },
        {
          to: '/portal-users',
          label: 'Portal users',
          icon: <UsersRound className="size-4" />,
          show: mayPortals,
        },
        {
          to: '/portal-submissions',
          label: 'Portal submissions',
          icon: <InboxIcon className="size-4" />,
          show: mayPortals,
        },
      ],
    },
    {
      group: 'Estimation',
      icon: <Calculator className="size-4" />,
      also: ['/boqs', '/rfqs'],
      items: [
        {
          group: 'Tenders and BOQ',
          icon: <ScrollText className="size-4" />,
          items: [
            { to: '/tenders', label: 'Tenders', icon: <ScrollText className="size-4" /> },
            { to: '/rfqs', label: 'Enquiries (RFQs)', icon: <Send className="size-4" /> },
            {
              to: '/boq-templates',
              label: 'BOQ templates',
              icon: <LayoutTemplate className="size-4" />,
            },
          ],
        },
        {
          group: 'Rates and resources',
          icon: <Boxes className="size-4" />,
          items: [
            { to: '/resources', label: 'Resources', icon: <Boxes className="size-4" /> },
            {
              to: '/rate-analyses',
              label: 'Rate analyses',
              icon: <Calculator className="size-4" />,
            },
            { to: '/cost-codes', label: 'Cost codes', icon: <Tags className="size-4" /> },
          ],
        },
        {
          group: 'Estimation reports',
          icon: <ChartColumn className="size-4" />,
          items: [
            {
              to: '/dashboards/estimation',
              label: 'Estimation dashboard',
              icon: <ChartPie className="size-4" />,
            },
          ],
        },
      ],
    },
    {
      group: 'Projects',
      icon: <Building2 className="size-4" />,
      also: ['/programmes', '/daily-reports', '/material-budgets', '/issues'],
      items: [
        { to: '/projects', label: 'Projects', icon: <Building2 className="size-4" /> },
        { to: '/portfolio', label: 'Portfolio', icon: <LayoutGrid className="size-4" /> },
        {
          to: '/registers/daily-reports',
          label: 'Daily reports',
          icon: <CalendarCheck className="size-4" />,
        },
        {
          to: '/monthly-review',
          label: 'Monthly review',
          icon: <CalendarCheck className="size-4" />,
        },
        {
          group: 'Cost and cash',
          icon: <Gauge className="size-4" />,
          also: ['/client-bills', '/subcontract-bills'],
          items: [
            { to: '/cost-control', label: 'Cost control', icon: <Gauge className="size-4" /> },
            {
              to: '/cash-flow',
              label: 'Cash flow',
              icon: <ArrowLeftRight className="size-4" />,
              show: mayBooks,
            },
            { to: '/earned-value', label: 'Earned value', icon: <TrendingUp className="size-4" /> },
          ],
        },
        {
          group: 'Contract',
          icon: <Scale className="size-4" />,
          items: [
            { to: '/variations', label: 'Variations', icon: <FilePlus2 className="size-4" /> },
            { to: '/contracts', label: 'Contracts and claims', icon: <Scale className="size-4" /> },
            { to: '/risks', label: 'Risk register', icon: <TriangleAlert className="size-4" /> },
          ],
        },
        {
          group: 'Site',
          icon: <HardHat className="size-4" />,
          items: [
            { to: '/quality', label: 'Quality', icon: <BadgeCheck className="size-4" /> },
            {
              to: '/registers/inspections',
              label: 'Inspections',
              icon: <ClipboardCheck className="size-4" />,
            },
            { to: '/registers/ncrs', label: 'NCRs', icon: <TriangleAlert className="size-4" /> },
            { to: '/safety', label: 'Safety', icon: <ShieldCheck className="size-4" /> },
            { to: '/mep', label: 'MEP', icon: <Fan className="size-4" /> },
          ],
        },
      ],
    },
    {
      group: 'Documents and design',
      icon: <FileStack className="size-4" />,
      items: [
        { to: '/documents', label: 'Documents', icon: <FileStack className="size-4" /> },
        {
          to: '/reviews',
          label: 'Reviews',
          icon: <FileCheck2 className="size-4" />,
          badge: pending?.reviews,
        },
        { to: '/transmittals', label: 'Transmittals and RFIs', icon: <Send className="size-4" /> },
        {
          to: '/registers/drawings',
          label: 'Drawings',
          icon: <LayoutTemplate className="size-4" />,
        },
        { to: '/registers/rfis', label: 'RFIs', icon: <ListChecks className="size-4" /> },
        {
          to: '/sign-offs',
          label: 'Sign-offs',
          icon: <Signature className="size-4" />,
          badge: pending?.signoffs,
        },
        {
          to: '/drawing-receipts',
          label: 'Drawing receipts',
          icon: <MailCheck className="size-4" />,
          badge: pending?.receipts,
        },
      ],
    },
    {
      group: 'Procurement and stores',
      icon: <ShoppingCart className="size-4" />,
      also: ['/transfers', '/stock-counts'],
      items: [
        { to: '/requisitions', label: 'Requisitions', icon: <ShoppingCart className="size-4" /> },
        { to: '/rfqs', label: 'Enquiries (RFQs)', icon: <Send className="size-4" /> },
        {
          to: '/clients',
          search: { kind: 'vendor' },
          label: 'Suppliers',
          icon: <Truck className="size-4" />,
        },
        {
          to: '/clients',
          search: { kind: 'subcontractor' },
          label: 'Subcontractors',
          icon: <HardHat className="size-4" />,
        },
        { to: '/orders', label: 'Orders', icon: <BriefcaseBusiness className="size-4" /> },
        { to: '/vendors', label: 'Vendor master', icon: <ShieldCheck className="size-4" /> },
        { to: '/rate-contracts', label: 'Rate contracts', icon: <Handshake className="size-4" /> },
        {
          to: '/deliveries',
          label: 'Delivery follow-up',
          icon: <CalendarClock className="size-4" />,
        },
        { to: '/receipts', label: 'Goods receipts', icon: <PackageCheck className="size-4" /> },
        { to: '/stores', label: 'Stores', icon: <Warehouse className="size-4" /> },
        {
          to: '/registers/stock-issues',
          label: 'Stock issues',
          icon: <ClipboardList className="size-4" />,
        },
        {
          to: '/registers/stock-transfers',
          label: 'Stock transfers',
          icon: <ArrowLeftRight className="size-4" />,
        },
        {
          to: '/procurement-reports',
          label: 'Procurement reports',
          icon: <ClipboardList className="size-4" />,
        },
      ],
    },
    {
      group: 'People',
      icon: <UsersRound className="size-4" />,
      items: [
        { to: '/hr/me', label: 'My attendance', icon: <Fingerprint className="size-4" /> },
        {
          to: '/hr/register',
          label: 'Site attendance',
          icon: <ClipboardCheck className="size-4" />,
          show: mayMark,
        },
        { to: '/hr', label: 'Employees', icon: <IdCard className="size-4" />, show: mayPeople },
        {
          to: '/payroll',
          label: 'Payroll',
          icon: <Banknote className="size-4" />,
          show: mayPayroll,
        },
        {
          to: '/payroll/increments',
          label: 'Increments',
          icon: <TrendingUp className="size-4" />,
          show: mayPayroll,
        },
        {
          to: '/labour',
          label: 'Contract labour',
          icon: <HardHat className="size-4" />,
          show: mayLabour,
        },
        {
          to: '/labour/muster',
          label: 'Labour muster',
          icon: <UsersRound className="size-4" />,
          show: mayLabour || mayMark,
        },
      ],
    },
    {
      group: 'Accounts',
      icon: <Landmark className="size-4" />,
      show: mayBooks,
      items: [
        {
          group: 'Transactions',
          icon: <ReceiptText className="size-4" />,
          also: [
            '/accounts/vendor-bills',
            '/accounts/client-receipts',
            '/accounts/payment-runs',
            '/accounts/ledgers',
          ],
          items: [
            {
              to: '/accounts/vouchers',
              label: 'Vouchers',
              icon: <ReceiptText className="size-4" />,
            },
            {
              to: '/accounts/receivables',
              label: 'Receivables',
              icon: <HandCoins className="size-4" />,
            },
            { to: '/accounts/payables', label: 'Payables', icon: <Wallet className="size-4" /> },
            { to: '/accounts/bank', label: 'Bank', icon: <Building2 className="size-4" /> },
            {
              to: '/registers/client-bills',
              label: 'Client bills',
              icon: <ReceiptText className="size-4" />,
            },
            {
              to: '/registers/subcontract-bills',
              label: 'Subcontract bills',
              icon: <ReceiptText className="size-4" />,
            },
          ],
        },
        {
          group: 'Tax',
          icon: <Percent className="size-4" />,
          items: [
            { to: '/accounts/gst', label: 'GST', icon: <Landmark className="size-4" /> },
            { to: '/accounts/tds', label: 'TDS', icon: <Percent className="size-4" /> },
          ],
        },
        {
          group: 'Assets',
          icon: <Truck className="size-4" />,
          items: [
            { to: '/equipment', label: 'Equipment', icon: <Construction className="size-4" /> },
            { to: '/accounts/assets', label: 'Fixed assets', icon: <Truck className="size-4" /> },
          ],
        },
        {
          group: 'Books and statements',
          icon: <FileBarChart className="size-4" />,
          items: [
            {
              to: '/accounts/statements',
              label: 'Statements',
              icon: <FileBarChart className="size-4" />,
            },
            {
              to: '/accounts/trial-balance',
              label: 'Trial balance',
              icon: <Scale className="size-4" />,
            },
            { to: '/accounts/day-book', label: 'Day book', icon: <BookOpen className="size-4" /> },
            {
              to: '/accounts/debit-note-proposals',
              label: 'Debit notes to raise',
              icon: <ReceiptText className="size-4" />,
            },
            {
              to: '/accounts/price-indices',
              label: 'Price indices',
              icon: <TrendingUp className="size-4" />,
            },
            {
              to: '/accounts/month-end-accruals',
              label: 'Month-end accruals',
              icon: <CalendarCheck className="size-4" />,
            },
            {
              to: '/accounts/revenue-recognition',
              label: 'Revenue on work done',
              icon: <Scale className="size-4" />,
            },
            {
              to: '/accounts/recurring',
              label: 'Recurring entries',
              icon: <Repeat className="size-4" />,
            },
            {
              to: '/accounts/close',
              label: 'Month-end close',
              icon: <CalendarCheck className="size-4" />,
            },
            {
              to: '/accounts/chart',
              label: 'Chart of accounts',
              icon: <ListTree className="size-4" />,
            },
            {
              to: '/accounts/setup',
              label: 'Books setup',
              icon: <CalendarCheck className="size-4" />,
            },
          ],
        },
      ],
    },
    {
      group: 'Reports',
      icon: <ChartColumn className="size-4" />,
      items: [
        {
          to: '/company-dashboard',
          label: 'Company dashboard',
          icon: <Gauge className="size-4" />,
          show: mayBooks,
        },
        { to: '/reports', label: 'Reports', icon: <ChartColumn className="size-4" /> },
        { to: '/reports/builder', label: 'Report builder', icon: <ChartPie className="size-4" /> },
      ],
    },
    {
      group: 'Administration',
      icon: <Settings2 className="size-4" />,
      show: isAdmin,
      items: [
        { to: '/users', label: 'Users', icon: <Users className="size-4" /> },
        {
          to: '/password-resets',
          label: 'Reset requests',
          icon: <KeyRound className="size-4" />,
          badge: pending?.passwordResets,
        },
        {
          to: '/settings/tenders',
          label: 'Tender settings',
          icon: <Settings2 className="size-4" />,
        },
        {
          to: '/settings/approvals',
          label: 'Approval rules',
          icon: <ListChecks className="size-4" />,
        },
        { to: '/settings/companies', label: 'Companies', icon: <Landmark className="size-4" /> },
        { to: '/settings/integrations', label: 'Integrations', icon: <Plug className="size-4" /> },
        { to: '/settings/imports', label: 'Imports', icon: <FileBarChart className="size-4" /> },
        { to: '/settings/audit', label: 'Audit trail', icon: <History className="size-4" /> },
      ],
    },
  ];

  // Every page in the menu, for search.
  const screens: ScreenEntry[] = [];
  const list = (items: (Page | Group)[], where: string) => {
    for (const i of items.filter(visible))
      if (isGroup(i)) list(i.items, i.group);
      else screens.push({ label: i.label, to: i.to, search: i.search, where });
  };
  list(menu, '');

  // Groups the person opened stay open on this device; the group holding the current page always opens.
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(load(OPEN_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      save(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  useEffect(() => {
    const here: string[] = [];
    const walk = (gs: (Page | Group)[]) => {
      for (const g of gs)
        if (isGroup(g) && visible(g) && holds(g, path)) {
          here.push(g.group);
          walk(g.items);
        }
    };
    walk(menu);
    if (projectId) walk(projectSections(projectId));
    if (here.some((k) => !open.has(k))) setOpen((prev) => new Set([...prev, ...here]));
  }, [path, projectId]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <div className="print:hidden">
        <LicenceBanner />
      </div>
      <div className="flex flex-1 flex-col md:flex-row">
        {/* On a wide screen the menu stays put and scrolls on its own; the page scrolls beside it. */}
        <aside className="print:hidden flex flex-col border-b border-line bg-surface md:sticky md:top-0 md:h-dvh md:w-64 md:shrink-0 md:border-b-0 md:border-r">
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
          <div
            className={`${menuOpen ? 'block' : 'hidden'} min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 md:block`}
            id="main-menu"
          >
            {projectId ? (
              <ProjectWorkspace projectId={projectId} open={open} toggle={toggle} />
            ) : null}
            <nav className="space-y-0.5" aria-label="Main">
              <NavItem
                to="/"
                icon={<Bell className="size-4" />}
                badge={(inbox.data?.unread ?? 0) + workCount(work.data)}
              >
                Home
              </NavItem>
              <NavItem
                to="/approvals"
                icon={<CheckCheck className="size-4" />}
                badge={pending?.approvals}
              >
                Approvals
              </NavItem>
              <div className="my-2 border-t border-line" />
              {menu.filter(visible).map((g) => (
                <NavGroup key={g.group} g={g} depth={0} open={open} toggle={toggle} />
              ))}
              <div className="px-2.5 pt-4">
                <Link to="/licences" className="text-xs text-fg-subtle hover:underline">
                  Third-party licences
                </Link>
              </div>
            </nav>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="print:hidden flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
            <div className="min-w-0 text-sm">
              <span className="font-medium">{session.user?.displayName}</span>{' '}
              <Badge>{session.user?.role}</Badge>
            </div>
            <div className="flex items-center gap-1">
              <SearchPalette screens={screens} />
              <NewMenu projectId={projectId} />
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
