// Reports (docs/wave1-plan.md step 12, docs/04-features.md E11): the bid pipeline across tenders, and for a BOQ its
// cost summary and the rate analyses behind it. Each report is a page meant for paper: printed (or saved as PDF by
// the browser's print dialog) as it is shown, and downloadable as Excel with the same figures.
import { Alert, Button, Card, Field, PageHeader, Select, Spinner } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  Calculator,
  Download,
  FileSpreadsheet,
  Printer,
  ScrollText,
  Trophy,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, saveFile } from '../api/client';
import type {
  AnalysisReport,
  BreakdownPart,
  CostSummary,
  Pipeline,
  ReportBoq,
  TenderStatus,
} from '../api/types';
import { describeError, formatDate, formatDateTime } from '../lib/format';
import { usePermission } from '../session/permissions';
import { VERTICALS } from './TenderForm';
import { STATUS_LABEL } from './Tenders';

const INR2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹ amounts with paise, as reports show them. */
export const money = (v: string | null | undefined) =>
  v === null || v === undefined || v === '' ? '' : INR2.format(Number(v));
const pct = (v: string | null | undefined) =>
  v === null || v === undefined ? '' : `${Number(v).toFixed(2)} %`;
const plain = (v: string | null | undefined) =>
  v === null || v === undefined ? '' : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export const PART_LABEL: Record<BreakdownPart, string> = {
  material: 'Material',
  labour: 'Labour',
  equipment: 'Equipment',
  subcontract: 'Subcontract',
  other: 'Other (lump sums)',
  additions: 'Overheads and profit in rates',
  not_analysed: 'Not analysed',
};
const PART_COLOUR: Record<BreakdownPart, string> = {
  material: '#2563eb',
  labour: '#16a34a',
  equipment: '#d97706',
  subcontract: '#7c3aed',
  other: '#64748b',
  additions: '#db2777',
  not_analysed: '#cbd5e1',
};

/** The reports page in the app: what is there and where to find it. */
export function ReportsScreen() {
  const canPrice = usePermission('pricing.edit');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Print them, save them as PDF, or download them as Excel."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ReportCard
          to="/reports/pipeline"
          icon={<ScrollText className="size-5" aria-hidden />}
          title="Bid pipeline"
        >
          Tenders by stage with estimates, due dates, owners and results, by financial year.
          {canPrice ? ' Includes the values we bid.' : ''}
        </ReportCard>
        {canPrice && (
          <ReportCard
            to="/tenders/win-loss"
            icon={<Trophy className="size-5" aria-hidden />}
            title="Win/loss"
          >
            Win rate by count and value, by client and vertical, against each competitor.
          </ReportCard>
        )}
        <Card title="For a BOQ">
          <p className="text-sm text-fg-muted">
            Open a BOQ and use <strong>Reports</strong>: the cost summary (by section and by
            material, labour, equipment and overheads) and the rate analysis report.{' '}
            <strong>Export</strong> there gives the BOQ priced or unpriced.
          </p>
        </Card>
      </div>
    </div>
  );
}

function ReportCard({
  to,
  icon,
  title,
  children,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-line bg-surface p-5 hover:border-accent hover:bg-surface-2"
    >
      <div className="flex items-center gap-2 font-semibold">
        {icon} {title}
      </div>
      <p className="mt-2 text-sm text-fg-muted">{children}</p>
    </Link>
  );
}

// --- the paper ---

/** A report page: a toolbar that does not print, then the paper. */
function Paper({
  back,
  excel,
  excelName,
  landscape = false,
  toolbar,
  children,
}: {
  back: ReactNode;
  excel: string;
  excelName: string;
  landscape?: boolean;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.download(excel);
      saveFile(blob, fileName || excelName);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-dvh bg-white text-black">
      <style>
        {`@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm }
          @media print { .no-print { display: none !important } .keep { break-inside: avoid } }`}
      </style>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-end gap-3 border-b border-gray-200 bg-white px-6 py-3">
        {back}
        {toolbar}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" busy={busy} onClick={() => void download()}>
            <Download className="size-4" aria-hidden /> Excel
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print or save as PDF
          </Button>
        </div>
        {error && (
          <div className="w-full">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </div>
      <article className="mx-auto max-w-[60rem] px-6 py-6 text-[13px] leading-snug print:max-w-none print:p-0">
        {children}
      </article>
    </div>
  );
}

const backClass = 'inline-flex items-center gap-1 pb-2 text-sm text-gray-600 hover:underline';
const backIcon = <ArrowLeft className="size-4" aria-hidden />;

function Heading({ title, lines, asOf }: { title: string; lines: ReactNode[]; asOf: string }) {
  return (
    <header className="mb-5 border-b-2 border-black pb-2">
      <h1 className="text-lg font-bold">{title}</h1>
      {lines.map((l, i) => (
        <div key={i} className="text-gray-700">
          {l}
        </div>
      ))}
      <div className="text-xs text-gray-500">As of {formatDateTime(asOf)}</div>
    </header>
  );
}

const boqLines = (b: ReportBoq) => [
  <>
    <strong>{b.name}</strong> · {b.tender.number} · {b.tender.title}
    {b.tender.client ? ` · ${b.tender.client}` : ''}
  </>,
  `Version ${b.versionNo} (${b.status}${b.archived ? ', archived' : ''}) · rates as on ${formatDate(b.rateDate)}`,
];

const th = 'border-b border-black px-1.5 py-1 text-left font-semibold';
const td = 'border-b border-gray-200 px-1.5 py-1 align-top';
const num = 'text-right tabular-nums';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="keep mb-6">
      <h2 className="mb-1.5 text-sm font-bold uppercase tracking-wide text-gray-700">{title}</h2>
      {children}
    </section>
  );
}

// --- cost summary ---

export function CostSummaryReport({ boqId }: { boqId: string }) {
  const q = useQuery({
    queryKey: ['cost-summary', boqId],
    queryFn: () => api.request<CostSummary>(`/api/tenant/boqs/${boqId}/cost-summary`),
  });
  return (
    <Paper
      back={
        <Link to="/boqs/$boqId" params={{ boqId }} className={backClass}>
          {backIcon} Back to the BOQ
        </Link>
      }
      excel={`/api/tenant/boqs/${boqId}/cost-summary/export`}
      excelName="cost summary.xlsx"
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <CostSummaryBody s={q.data} />
      )}
    </Paper>
  );
}

function CostSummaryBody({ s }: { s: CostSummary }) {
  const parts = s.breakdown.parts.filter((p) => Number(p.amount) !== 0);
  return (
    <>
      <Heading title="Cost summary" lines={boqLines(s.boq)} asOf={s.asOf} />
      <Section title="By section">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Code</th>
              <th className={th}>Section</th>
              <th className={`${th} ${num}`}>Amount (₹)</th>
              <th className={`${th} ${num}`}>% of BOQ</th>
            </tr>
          </thead>
          <tbody>
            {s.sections.map((x, i) => (
              <tr key={i}>
                <td className={td}>{x.code}</td>
                <td className={td}>{x.description}</td>
                <td className={`${td} ${num}`}>{money(x.amount)}</td>
                <td className={`${td} ${num}`}>{pct(x.pct)}</td>
              </tr>
            ))}
            {s.unsectioned.items > 0 && (
              <tr>
                <td className={td} />
                <td className={`${td} italic`}>Items outside sections ({s.unsectioned.items})</td>
                <td className={`${td} ${num}`}>{money(s.unsectioned.amount)}</td>
                <td className={td} />
              </tr>
            )}
            <tr className="font-bold">
              <td className="px-1.5 py-1" />
              <td className="px-1.5 py-1">BOQ total</td>
              <td className={`px-1.5 py-1 ${num}`} data-testid="boq-total">
                {money(s.boq.total)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title="What it is made of">
        {Number(s.breakdown.total) === 0 ? (
          <p className="text-gray-600">Nothing is priced yet.</p>
        ) : (
          <>
            <div className="mb-2 flex h-4 w-full overflow-hidden rounded-sm" aria-hidden>
              {parts.map((p) => (
                <div
                  key={p.part}
                  style={{
                    width: `${Math.max(0, Number(p.pct ?? 0))}%`,
                    background: PART_COLOUR[p.part],
                    printColorAdjust: 'exact',
                    WebkitPrintColorAdjust: 'exact',
                  }}
                />
              ))}
            </div>
            <table className="w-full border-collapse" aria-label="Cost breakdown">
              <tbody>
                {s.breakdown.parts.map((p) => (
                  <tr key={p.part}>
                    <td className={td}>
                      <span
                        className="mr-2 inline-block size-2.5 rounded-sm align-middle"
                        style={{ background: PART_COLOUR[p.part], printColorAdjust: 'exact' }}
                      />
                      {PART_LABEL[p.part]}
                    </td>
                    <td className={`${td} ${num}`}>{money(p.amount)}</td>
                    <td className={`${td} ${num} w-24`}>{pct(p.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-xs text-gray-600">
              Each item is split in the proportions of its rate analysis on the rate date. Items
              without an analysis are &ldquo;not analysed&rdquo;.
            </p>
          </>
        )}
        {s.incomplete.length > 0 && (
          <p className="mt-1.5 text-xs text-amber-800">
            No rate on {formatDate(s.boq.rateDate)} for some resources, so these analyses are split
            without them:{' '}
            {s.incomplete.map((a) => `${a.code} (${a.missing.join(', ')})`).join('; ')}.
          </p>
        )}
      </Section>

      <Section title="Items">
        <p>
          {s.counts.items.toLocaleString('en-IN')} items: {s.counts.priced.toLocaleString('en-IN')}{' '}
          priced,{' '}
          <span className={s.counts.unpriced ? 'font-semibold text-red-700' : ''}>
            {s.counts.unpriced.toLocaleString('en-IN')} not priced
          </span>
          , {s.counts.noQty.toLocaleString('en-IN')} without quantity;{' '}
          {s.counts.analysed.toLocaleString('en-IN')} linked to a rate analysis.
        </p>
      </Section>

      {s.bid ? (
        <Section title={`Bid: ${s.bid.scenario}`}>
          <table className="w-full border-collapse" aria-label="Bid">
            <tbody>
              <tr>
                <td className={td}>BOQ value</td>
                <td className={td} />
                <td className={`${td} ${num}`}>{money(s.bid.base)}</td>
              </tr>
              {s.bid.markups.map((m, i) => (
                <tr key={i}>
                  <td className={td}>{m.label}</td>
                  <td className={`${td} ${num} w-24`}>
                    {m.pct === null ? '' : `${plain(m.pct)} %`}
                  </td>
                  <td className={`${td} ${num}`}>{money(m.amount)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className={td}>Before GST</td>
                <td className={`${td} ${num}`}>
                  {s.bid.vsEstimatePct !== null &&
                    `${Number(s.bid.vsEstimatePct) > 0 ? '+' : ''}${pct(s.bid.vsEstimatePct)} vs estimate`}
                </td>
                <td className={`${td} ${num}`}>{money(s.bid.beforeGst)}</td>
              </tr>
              <tr>
                <td className={td}>
                  GST
                  {s.bid.gstMode === 'included'
                    ? ' (in the rates)'
                    : s.bid.gstMode === 'exempt'
                      ? ' (exempt)'
                      : ''}
                </td>
                <td className={td} />
                <td className={`${td} ${num}`}>{money(s.bid.gst)}</td>
              </tr>
              <tr className="font-bold">
                <td className="px-1.5 py-1">Bid</td>
                <td />
                <td className={`px-1.5 py-1 ${num}`} data-testid="bid-total">
                  {money(s.bid.bid)}
                </td>
              </tr>
            </tbody>
          </table>
        </Section>
      ) : (
        !s.pricingHidden && (
          <p className="text-gray-600">
            No pricing scenario is selected for this BOQ, so there is no bid yet.
          </p>
        )
      )}
    </>
  );
}

// --- rate analyses ---

export function AnalysisReportPrint({ boqId }: { boqId: string }) {
  const q = useQuery({
    queryKey: ['analysis-report', boqId],
    queryFn: () => api.request<AnalysisReport>(`/api/tenant/boqs/${boqId}/analysis-report`),
  });
  return (
    <Paper
      back={
        <Link to="/boqs/$boqId" params={{ boqId }} className={backClass}>
          {backIcon} Back to the BOQ
        </Link>
      }
      excel={`/api/tenant/boqs/${boqId}/analysis-report/export`}
      excelName="rate analyses.xlsx"
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <Heading title="Rate analyses" lines={boqLines(q.data.boq)} asOf={q.data.asOf} />
          {q.data.analyses.length === 0 && (
            <p className="text-gray-600">No item of this BOQ is linked to a rate analysis.</p>
          )}
          {q.data.analyses.map((a) => (
            <section key={a.id} className="keep mb-6" aria-label={a.code}>
              <h2 className="font-bold">
                {a.code} · {a.description}
              </h2>
              <div className="mb-1 text-xs text-gray-600">
                For {plain(a.outputQty)} {a.unit}
                {a.direct
                  ? ` · ${a.items} item${a.items === 1 ? '' : 's'} in this BOQ${a.qty ? `, ${plain(a.qty)} ${a.unit}` : ''}`
                  : ' · used inside other analyses'}
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${th} w-8`}>#</th>
                    <th className={th}>Resource</th>
                    <th className={`${th} ${num}`}>Qty</th>
                    <th className={th}>Unit</th>
                    <th className={`${th} ${num}`}>Wastage</th>
                    <th className={`${th} ${num}`}>Rate (₹)</th>
                    <th className={`${th} ${num}`}>Cost (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {a.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className={td}>{l.lineNo}</td>
                      <td className={td}>
                        {l.code ? <span className="mr-1.5 font-mono text-xs">{l.code}</span> : null}
                        {l.description}
                        {l.kind === 'lump_sum' && (
                          <span className="text-gray-500"> (lump sum)</span>
                        )}
                      </td>
                      <td className={`${td} ${num}`}>
                        {l.kind === 'lump_sum' ? '' : plain(l.qty)}
                      </td>
                      <td className={td}>{l.unit}</td>
                      <td className={`${td} ${num}`}>
                        {l.wastagePct && Number(l.wastagePct) !== 0
                          ? `${plain(l.wastagePct)} %`
                          : ''}
                      </td>
                      <td className={`${td} ${num}`}>
                        {l.unitCost === null ? '' : money(l.unitCost)}
                      </td>
                      <td className={`${td} ${num}`}>{money(l.cost)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={6} className={`${td} text-right`}>
                      Subtotal
                    </td>
                    <td className={`${td} ${num}`}>{money(a.subtotal)}</td>
                  </tr>
                  {a.additions.map((x, i) => (
                    <tr key={i}>
                      <td colSpan={6} className={`${td} text-right`}>
                        {x.label} ({plain(x.pct)} %)
                      </td>
                      <td className={`${td} ${num}`}>{money(x.amount)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td colSpan={6} className={`${td} text-right`}>
                      Total for {plain(a.outputQty)} {a.unit}
                    </td>
                    <td className={`${td} ${num}`}>{money(a.total)}</td>
                  </tr>
                  <tr className="font-bold">
                    <td colSpan={6} className="px-1.5 py-1 text-right">
                      Rate per {a.unit}
                    </td>
                    <td className={`px-1.5 py-1 ${num}`}>{money(a.boqRate)}</td>
                  </tr>
                </tbody>
              </table>
              {a.missing.length > 0 && (
                <p className="mt-1 text-xs text-amber-800">
                  No rate on {formatDate(q.data.boq.rateDate)} for {a.missing.join(', ')}: costed at
                  nil.
                </p>
              )}
              {a.error && <p className="mt-1 text-xs text-red-700">{a.error}</p>}
            </section>
          ))}
        </>
      )}
    </Paper>
  );
}

// --- bid pipeline ---

export function PipelineReport() {
  // Dashboards open this report already filtered (drill-down): the address carries the filters.
  const [initial] = useState(() => new URLSearchParams(window.location.search));
  const [fy, setFy] = useState(initial.get('fy') ?? '');
  const [status, setStatus] = useState(initial.get('status') ?? 'all');
  const [vertical, setVertical] = useState(initial.get('vertical') ?? '');
  const [owner, setOwner] = useState(initial.get('owner') ?? '');
  const qs = new URLSearchParams(
    Object.entries({ fy, status, vertical, owner }).filter(([, v]) => v !== ''),
  ).toString();
  const q = useQuery({
    queryKey: ['pipeline-report', qs],
    queryFn: () => api.request<Pipeline>(`/api/tenant/reports/pipeline?${qs}`),
    placeholderData: (prev) => prev,
  });
  const p = q.data;
  const filterText = [
    fy ? `FY ${fy}` : 'All years',
    status === 'open'
      ? 'open tenders'
      : status !== 'all'
        ? STATUS_LABEL[status as TenderStatus]
        : null,
    vertical ? VERTICALS[vertical] : null,
    owner ? p?.owners.find((o) => o.id === owner)?.name : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Paper
      landscape
      back={
        <Link to="/reports" className={backClass}>
          {backIcon} Reports
        </Link>
      }
      excel={`/api/tenant/reports/pipeline/export?${qs}`}
      excelName="Bid pipeline.xlsx"
      toolbar={
        <>
          <Field label="Financial year">
            <Select value={fy} onChange={(e) => setFy(e.target.value)} className="w-32">
              <option value="">All years</option>
              {p?.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
              <option value="all">All</option>
              <option value="open">Open</option>
              {Object.entries(STATUS_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vertical">
            <Select value={vertical} onChange={(e) => setVertical(e.target.value)} className="w-36">
              <option value="">All</option>
              {Object.entries(VERTICALS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-40">
              <option value="">Anyone</option>
              {p?.owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
    >
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        p && (
          <>
            <Heading
              title="Bid pipeline"
              lines={[
                filterText,
                <>
                  {p.totals.tenders} tender{p.totals.tenders === 1 ? '' : 's'}, {p.totals.open} open
                  · pipeline ₹
                  <span data-testid="pipeline-value">{money(p.totals.pipelineValue)}</span>
                  {p.totals.submittedValue !== null &&
                    ` · bid ₹${money(p.totals.submittedValue)}`}{' '}
                  · {p.totals.won} won, ₹{money(p.totals.wonValue)}
                </>,
              ]}
              asOf={p.asOf}
            />
            <Section title="By stage">
              <table className="w-auto border-collapse" aria-label="By stage">
                <thead>
                  <tr>
                    <th className={th}>Stage</th>
                    <th className={`${th} ${num}`}>Tenders</th>
                    <th className={`${th} ${num}`}>Estimate (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {p.stages
                    .filter((s) => s.count > 0)
                    .map((s) => (
                      <tr key={s.status}>
                        <td className={`${td} pr-8`}>{STATUS_LABEL[s.status]}</td>
                        <td className={`${td} ${num} pl-8`}>{s.count}</td>
                        <td className={`${td} ${num} pl-8`}>{money(s.estimatedValue)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Section>
            <Section title="Tenders">
              {p.rows.length === 0 ? (
                <p className="text-gray-600">No tenders match.</p>
              ) : (
                <table className="w-full border-collapse" aria-label="Tenders">
                  <thead>
                    <tr>
                      <th className={th}>Number</th>
                      <th className={th}>Title · client</th>
                      <th className={th}>Status</th>
                      <th className={th}>Owner</th>
                      <th className={`${th} ${num}`}>Estimate (₹)</th>
                      <th className={th}>Due</th>
                      {!p.pricingHidden && <th className={`${th} ${num}`}>Our bid (₹)</th>}
                      <th className={th}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={r.id} className="keep">
                        <td className={`${td} whitespace-nowrap`}>
                          <Link
                            to="/tenders/$tenderId"
                            params={{ tenderId: r.id }}
                            className="hover:underline"
                          >
                            {r.number}
                          </Link>
                        </td>
                        <td className={td}>
                          {r.title}
                          {r.client && <div className="text-xs text-gray-600">{r.client}</div>}
                        </td>
                        <td className={td}>{STATUS_LABEL[r.status]}</td>
                        <td className={td}>{r.owner}</td>
                        <td className={`${td} ${num}`}>{money(r.estimatedValue)}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {r.submissionDueAt ? formatDate(r.submissionDueAt) : ''}
                        </td>
                        {!p.pricingHidden && <td className={`${td} ${num}`}>{money(r.ourBid)}</td>}
                        <td className={td}>
                          {r.resultOn && formatDate(r.resultOn)}
                          {r.awardedValue && (
                            <div className="text-xs">₹{money(r.awardedValue)}</div>
                          )}
                          {r.awardedTo && (
                            <div className="text-xs text-gray-600">{r.awardedTo}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </>
        )
      )}
    </Paper>
  );
}

/** On the BOQ page: the BOQ's reports. */
export function BoqReportsMenu({ boqId }: { boqId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <FileSpreadsheet className="size-4" aria-hidden /> Reports
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-line bg-surface p-1 shadow-lg"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <Link
            role="menuitem"
            to="/boqs/$boqId/cost-summary"
            params={{ boqId }}
            className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-2"
          >
            <FileSpreadsheet className="size-4" aria-hidden /> Cost summary
          </Link>
          <Link
            role="menuitem"
            to="/boqs/$boqId/analysis-report"
            params={{ boqId }}
            className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-2"
          >
            <Calculator className="size-4" aria-hidden /> Rate analyses
          </Link>
        </div>
      )}
    </div>
  );
}
