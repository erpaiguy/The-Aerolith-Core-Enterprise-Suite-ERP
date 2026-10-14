// My work (docs/wave7-plan.md step 7a.7): on Home, what waits on this person, by kind, each line opening its record.
import { Badge, Card, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';
import { useSession } from '../session/session';

interface Project {
  id: string;
  number: string;
  name: string;
}
interface Section<T> {
  count: number;
  items: T[];
}
export interface MyWork {
  approvals: Section<{
    id: string;
    docType: string;
    title: string;
    amount: string;
    submittedBy: string;
  }>;
  rfis: Section<{
    id: string;
    number: string;
    subject: string;
    dueOn: string;
    overdue: boolean;
    project: Project;
  }>;
  bills: Section<{
    id: string;
    raNo: number;
    upto: string;
    subcontractor: string;
    net: string | null;
    project: Project;
  }>;
  orders: Section<{
    id: string;
    number: string;
    supplier: string;
    status: string;
    project: Project;
  }>;
  ncrs: Section<{
    id: string;
    number: string;
    description: string;
    status: string;
    dueOn: string | null;
    project: Project;
  }>;
  followUps: Section<{ id: string; followUp: string; dueOn: string; leadId: string; lead: string }>;
  actions?: Section<{
    id: string;
    description: string;
    dueOn: string;
    overdue: boolean;
    meetingId: string;
    meeting: string;
    project: Project;
  }>;
  findings?: Section<{
    id: string;
    observation: string;
    severity: string;
    dueOn: string;
    overdue: boolean;
    walkId: string;
    walk: string;
    project: Project;
  }>;
}

export const useMyWork = () => {
  const session = useSession();
  return useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.request<MyWork>('/api/tenant/my-work'),
    enabled: session.status === 'signed_in',
    refetchInterval: 60_000,
  });
};

/** What the menu counts on Home: things to act on now (approvals have their own count; orders are to watch). */
export const workCount = (w: MyWork | undefined) =>
  w
    ? w.rfis.count +
      w.bills.count +
      w.ncrs.count +
      w.followUps.count +
      (w.actions?.count ?? 0) +
      (w.findings?.count ?? 0)
    : 0;

function Part({
  title,
  count,
  all,
  children,
}: {
  title: string;
  count: number;
  all?: ReactNode;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        {title} <Badge tone="accent">{count}</Badge>
        <span className="flex-1" />
        {all}
      </h3>
      <ul className="divide-y divide-line text-sm">{children}</ul>
    </section>
  );
}
const line = 'flex flex-wrap items-baseline gap-x-2 py-1.5';
const muted = 'text-xs text-fg-muted';

export function MyWorkCard() {
  const work = useMyWork();
  if (work.isPending) return <Spinner />;
  if (!work.data) return null;
  const w = work.data;
  const total = Object.values(w).reduce((n, s) => n + (s?.count ?? 0), 0);
  return (
    <Card title="My work">
      {total === 0 ? (
        <p className="text-sm text-fg-muted">Nothing waits on you.</p>
      ) : (
        <div className="space-y-4">
          <Part
            title="Approvals"
            count={w.approvals.count}
            all={
              <Link to="/approvals" className="text-xs font-normal text-accent hover:underline">
                All
              </Link>
            }
          >
            {w.approvals.items.map((a) => (
              <li key={a.id} className={line}>
                <Link
                  to="/approvals/$approvalId"
                  params={{ approvalId: a.id }}
                  className="hover:underline"
                >
                  {a.title}
                </Link>
                <span className={muted}>
                  {a.docType.replace(/_/g, ' ')} · {a.submittedBy}
                  {Number(a.amount) > 0 ? ` · ${formatInr(a.amount)}` : ''}
                </span>
              </li>
            ))}
          </Part>
          <Part title="RFIs to answer" count={w.rfis.count}>
            {w.rfis.items.map((r) => (
              <li key={r.id} className={line}>
                <Link
                  to="/transmittals"
                  search={{ project: r.project.id }}
                  className="hover:underline"
                >
                  <span className="font-mono text-xs">{r.number}</span> {r.subject}
                </Link>
                <span className={r.overdue ? 'text-xs font-medium text-danger' : muted}>
                  {r.project.name} · due {shortDate(r.dueOn)}
                </span>
              </li>
            ))}
          </Part>
          <Part title="Bills to certify" count={w.bills.count}>
            {w.bills.items.map((b) => (
              <li key={b.id} className={line}>
                <Link
                  to="/subcontract-bills/$billId"
                  params={{ billId: b.id }}
                  className="hover:underline"
                >
                  {b.subcontractor} RA {b.raNo}
                </Link>
                <span className={muted}>
                  {b.project.name} · up to {shortDate(b.upto)}
                  {b.net ? ` · ${formatInr(b.net)}` : ''}
                </span>
              </li>
            ))}
          </Part>
          <Part title="NCRs open" count={w.ncrs.count}>
            {w.ncrs.items.map((n) => (
              <li key={n.id} className={line}>
                <Link to="/quality" search={{ project: n.project.id }} className="hover:underline">
                  <span className="font-mono text-xs">{n.number}</span> {n.description}
                </Link>
                <span className={muted}>
                  {n.project.name} · {n.status.replace(/_/g, ' ')}
                  {n.dueOn ? ` · due ${shortDate(n.dueOn)}` : ''}
                </span>
              </li>
            ))}
          </Part>
          <Part title="Meeting actions" count={w.actions?.count ?? 0}>
            {(w.actions?.items ?? []).map((a) => (
              <li key={a.id} className={line}>
                <Link
                  to="/projects/$projectId/meetings"
                  params={{ projectId: a.project.id }}
                  className="hover:underline"
                >
                  {a.description}
                </Link>
                <span className={a.overdue ? 'text-xs font-medium text-danger' : muted}>
                  {a.meeting} · {a.project.name} · by {shortDate(a.dueOn)}
                </span>
              </li>
            ))}
          </Part>
          <Part title="Safety findings" count={w.findings?.count ?? 0}>
            {(w.findings?.items ?? []).map((f) => (
              <li key={f.id} className={line}>
                <Link
                  to="/projects/$projectId/site-walks"
                  params={{ projectId: f.project.id }}
                  className="hover:underline"
                >
                  {f.observation}
                </Link>
                <span className={f.overdue ? 'text-xs font-medium text-danger' : muted}>
                  {f.walk} · {f.severity} · {f.project.name} · by {shortDate(f.dueOn)}
                </span>
              </li>
            ))}
          </Part>
          <Part title="Follow-ups this week" count={w.followUps.count}>
            {w.followUps.items.map((f) => (
              <li key={f.id} className={line}>
                <Link to="/crm" className="hover:underline">
                  {f.lead}
                </Link>
                <span className={muted}>
                  {f.followUp || 'Follow up'} · {shortDate(f.dueOn)}
                </span>
              </li>
            ))}
          </Part>
          <Part title="Orders to receive" count={w.orders.count}>
            {w.orders.items.map((o) => (
              <li key={o.id} className={line}>
                <Link to="/orders/$orderId" params={{ orderId: o.id }} className="hover:underline">
                  <span className="font-mono text-xs">{o.number}</span> {o.supplier}
                </Link>
                <span className={muted}>
                  {o.project.name} · {o.status}
                </span>
              </li>
            ))}
          </Part>
        </div>
      )}
    </Card>
  );
}
