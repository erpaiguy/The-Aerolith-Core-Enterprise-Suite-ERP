// Procurement reports (docs/wave2b-plan.md step 9): requisition to order to receipt, what suppliers still owe, material
// reconciliation with wastage against the norms, and supplier performance; each also as Excel. A project's four, and
// the company's open orders and suppliers over the projects the user sees.
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, FileSpreadsheet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, saveFile } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { rupees } from '../procurement/OrderLines';
import { shortDate } from '../schedule/model';
import { numberLocale } from '../lib/locale';

type Stage = 'not_asked' | 'asked' | 'part_ordered' | 'ordered' | 'part_received' | 'received';
const STAGE: Record<Stage, string> = {
  not_asked: 'Not asked yet',
  asked: 'Asked vendors',
  part_ordered: 'Partly ordered',
  ordered: 'Ordered',
  part_received: 'Partly received',
  received: 'Received',
};
const STAGE_TONE = {
  not_asked: 'danger',
  asked: 'warning',
  part_ordered: 'warning',
  ordered: 'accent',
  part_received: 'accent',
  received: 'success',
} as const;

interface RequisitionReport {
  today: string;
  lines: {
    requisitionId: string;
    number: string;
    title: string;
    position: number;
    description: string;
    unit: string;
    qty: string;
    ordered: string;
    received: string;
    outstanding: string;
    stage: Stage;
    enquiries: string[];
    orders: string[];
    neededBy: string | null;
    ageDays: number | null;
    late: boolean;
  }[];
}
interface OpenOrders {
  lines: {
    orderId: string;
    number: string;
    project: { id: string; number: string; name: string };
    vendor: string;
    description: string;
    unit: string;
    ordered: string;
    received: string;
    outstanding: string;
    value: string;
    deliverBy: string | null;
    daysLate: number;
  }[];
  suppliers: { vendor: string; lines: number; late: number; value: string }[];
}
interface Materials {
  lines: {
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    budget: string | null;
    requisitioned: string;
    ordered: string;
    received: string;
    issued: string;
    inStock: string;
    theoretical: string | null;
    wastage: string | null;
    wastagePct: string | null;
  }[];
}
interface Suppliers {
  suppliers: {
    partyId: string;
    vendor: string;
    orders: number;
    orderedValue: string;
    receiptLines: number;
    onTimePct: string | null;
    rejectedPct: string | null;
    overL1Pct: string | null;
  }[];
}

/** A quantity without trailing zeros: "145.0000" → "145". */
const qty = (v: string | null) => (v === null ? '-' : Number(v).toLocaleString(numberLocale()));
const pct = (v: string | null) => (v === null ? '-' : `${v}%`);

function Report<T>({
  title,
  url,
  children,
  note,
}: {
  title: string;
  url: string;
  note?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const data = useQuery({
    queryKey: ['procurement-report', url],
    queryFn: () => api.request<T>(url),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excel = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.download(
        `${url}${url.includes('?') ? '&' : '?'}format=xlsx`,
      );
      saveFile(blob, fileName);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={title}
      actions={
        <Button type="button" variant="secondary" busy={busy} onClick={() => void excel()}>
          <FileSpreadsheet className="size-4" aria-hidden /> Excel
        </Button>
      }
    >
      <div className="space-y-3">
        {note && <p className="text-sm text-fg-muted">{note}</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        {data.isPending ? (
          <Spinner />
        ) : data.isError ? (
          <Alert tone="danger">{describeError(data.error)}</Alert>
        ) : (
          children(data.data)
        )}
      </div>
    </Card>
  );
}

const None = () => (
  <EmptyState title="Nothing yet.">
    The report fills as requisitions are raised, orders placed and goods received.
  </EmptyState>
);

function RequisitionTracker({ projectId }: { projectId: string }) {
  return (
    <Report<RequisitionReport>
      title="Requisition to order to receipt"
      url={`/api/tenant/projects/${projectId}/reports/requisitions`}
      note="Each line of the approved requisitions: what was ordered and has come against it."
    >
      {(r) =>
        r.lines.length === 0 ? (
          <None />
        ) : (
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>Requisition</th>
                <th>Line</th>
                <th className="text-right">Asked for</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">To come</th>
                <th>Stage</th>
                <th>Orders</th>
                <th>Needed by</th>
                <th className="text-right">Days open</th>
              </tr>
            </thead>
            <tbody aria-label="Requisition lines">
              {r.lines.map((l) => (
                <tr key={`${l.requisitionId}-${l.position}`}>
                  <td>
                    <Link
                      to="/requisitions/$requisitionId"
                      params={{ requisitionId: l.requisitionId }}
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {l.number}
                    </Link>
                    <div className="text-xs text-fg-muted">{l.title}</div>
                  </td>
                  <td>
                    {l.description} <span className="text-xs text-fg-muted">{l.unit}</span>
                  </td>
                  <td className="text-right tabular-nums">{qty(l.qty)}</td>
                  <td className="text-right tabular-nums">{qty(l.ordered)}</td>
                  <td className="text-right tabular-nums">{qty(l.received)}</td>
                  <td className="text-right tabular-nums">{qty(l.outstanding)}</td>
                  <td>
                    <Badge tone={STAGE_TONE[l.stage]}>{STAGE[l.stage]}</Badge>
                  </td>
                  <td className="font-mono text-xs">{l.orders.join(', ') || '-'}</td>
                  <td className="whitespace-nowrap text-sm">
                    {l.neededBy ? shortDate(l.neededBy) : '-'}{' '}
                    {l.late && <Badge tone="danger">Late</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{l.ageDays ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </Report>
  );
}

function OpenOrdersReport({ projectId }: { projectId?: string }) {
  return (
    <Report<OpenOrders>
      title="Open orders"
      url={`/api/tenant/reports/open-orders${projectId ? `?projectId=${projectId}` : ''}`}
      note="What suppliers still owe on issued purchase orders, valued at the order rate before GST."
    >
      {(r) =>
        r.lines.length === 0 ? (
          <None />
        ) : (
          <div className="space-y-4">
            <Table minWidth="30rem">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th className="text-right">Lines owed</th>
                  <th className="text-right">Late</th>
                  <th className="text-right">Value owed</th>
                </tr>
              </thead>
              <tbody aria-label="Owed by supplier">
                {r.suppliers.map((s) => (
                  <tr key={s.vendor}>
                    <td>{s.vendor}</td>
                    <td className="text-right tabular-nums">{s.lines}</td>
                    <td className="text-right tabular-nums">{s.late || '-'}</td>
                    <td className="text-right tabular-nums">{rupees(s.value)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Table minWidth="56rem">
              <thead>
                <tr>
                  <th>Order</th>
                  {!projectId && <th>Project</th>}
                  <th>Supplier</th>
                  <th>Line</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Owed</th>
                  <th className="text-right">Value</th>
                  <th>Deliver by</th>
                </tr>
              </thead>
              <tbody aria-label="Open order lines">
                {r.lines.map((l, i) => (
                  <tr key={`${l.orderId}-${i}`}>
                    <td>
                      <Link
                        to="/orders/$orderId"
                        params={{ orderId: l.orderId }}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {l.number}
                      </Link>
                    </td>
                    {!projectId && <td className="text-sm">{l.project.name}</td>}
                    <td className="text-sm">{l.vendor}</td>
                    <td>
                      {l.description} <span className="text-xs text-fg-muted">{l.unit}</span>
                    </td>
                    <td className="text-right tabular-nums">{qty(l.ordered)}</td>
                    <td className="text-right tabular-nums">{qty(l.received)}</td>
                    <td className="text-right tabular-nums">{qty(l.outstanding)}</td>
                    <td className="text-right tabular-nums">{rupees(l.value)}</td>
                    <td className="whitespace-nowrap text-sm">
                      {l.deliverBy ? shortDate(l.deliverBy) : '-'}{' '}
                      {l.daysLate > 0 && <Badge tone="danger">{l.daysLate} days late</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )
      }
    </Report>
  );
}

function MaterialsReport({ projectId }: { projectId: string }) {
  return (
    <Report<Materials>
      title="Material reconciliation"
      url={`/api/tenant/projects/${projectId}/reports/materials`}
      note="Should have taken: the measured work at the budget's norms. Wastage: issued over that."
    >
      {(r) =>
        r.lines.length === 0 ? (
          <None />
        ) : (
          <Table minWidth="60rem">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Budget</th>
                <th className="text-right">Requisitioned</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">Issued</th>
                <th className="text-right">In stock</th>
                <th className="text-right">Should have taken</th>
                <th className="text-right">Wastage</th>
              </tr>
            </thead>
            <tbody aria-label="Materials">
              {r.lines.map((l) => (
                <tr key={l.resourceId}>
                  <td>
                    {l.name}{' '}
                    <span className="font-mono text-xs text-fg-muted">
                      {l.code} · {l.unit}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{qty(l.budget)}</td>
                  <td className="text-right tabular-nums">{qty(l.requisitioned)}</td>
                  <td className="text-right tabular-nums">{qty(l.ordered)}</td>
                  <td className="text-right tabular-nums">{qty(l.received)}</td>
                  <td className="text-right tabular-nums">{qty(l.issued)}</td>
                  <td className="text-right tabular-nums">{qty(l.inStock)}</td>
                  <td className="text-right tabular-nums">{qty(l.theoretical)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {l.wastage === null ? (
                      '-'
                    ) : (
                      <span className={Number(l.wastage) > 0 ? 'text-danger' : undefined}>
                        {qty(l.wastage)} ({pct(l.wastagePct)})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </Report>
  );
}

function SuppliersReport({ projectId }: { projectId?: string }) {
  return (
    <Report<Suppliers>
      title="Supplier performance"
      url={`/api/tenant/reports/suppliers${projectId ? `?projectId=${projectId}` : ''}`}
      note="On time: receipts on or before the order's date. Rejected: by value at the order rate. Above the lowest quote: what was paid against the lowest rate quoted (before GST) on the same enquiry lines."
    >
      {(r) =>
        r.suppliers.length === 0 ? (
          <None />
        ) : (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>Supplier</th>
                <th className="text-right">Orders</th>
                <th className="text-right">Ordered (with GST)</th>
                <th className="text-right">Receipts</th>
                <th className="text-right">On time</th>
                <th className="text-right">Rejected</th>
                <th className="text-right">Above lowest quote</th>
              </tr>
            </thead>
            <tbody aria-label="Suppliers">
              {r.suppliers.map((s) => (
                <tr key={s.partyId}>
                  <td>{s.vendor}</td>
                  <td className="text-right tabular-nums">{s.orders}</td>
                  <td className="text-right tabular-nums">{rupees(s.orderedValue)}</td>
                  <td className="text-right tabular-nums">{s.receiptLines}</td>
                  <td className="text-right tabular-nums">{pct(s.onTimePct)}</td>
                  <td className="text-right tabular-nums">{pct(s.rejectedPct)}</td>
                  <td className="text-right tabular-nums">{pct(s.overL1Pct)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </Report>
  );
}

export function ProjectProcurementReportsScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  return (
    <div className="space-y-5">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />{' '}
        {project.data ? `${project.data.number} · ${project.data.name}` : 'Project'}
      </Link>
      <h1 className="text-xl font-semibold">Procurement reports</h1>
      <RequisitionTracker projectId={projectId} />
      <OpenOrdersReport projectId={projectId} />
      <MaterialsReport projectId={projectId} />
      <SuppliersReport projectId={projectId} />
    </div>
  );
}

export function ProcurementReportsScreen() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Procurement reports"
        subtitle="Across the projects you are on. A project's requisition tracker and material reconciliation are on its page."
      />
      <OpenOrdersReport />
      <SuppliersReport />
    </div>
  );
}
