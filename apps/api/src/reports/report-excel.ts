// The reports as Excel workbooks: the same figures as the screen, as numbers that sum, with the "as of" time.
import ExcelJS from 'exceljs';
import type { AnalysisReport, BoqHead, CostSummary, Pipeline } from './reports.service.js';

const MONEY = '#,##0.00';
const PART_LABEL: Record<string, string> = {
  material: 'Material',
  labour: 'Labour',
  equipment: 'Equipment',
  subcontract: 'Subcontract',
  other: 'Other (lump sums)',
  additions: 'Overheads and profit in rates',
  provisional: 'Provisional sums',
  not_analysed: 'Not analysed',
};
const STATUS_LABEL: Record<string, string> = {
  lead: 'Lead',
  evaluating: 'Evaluating',
  bidding: 'Bidding',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  no_bid: 'No bid',
  withdrawn: 'Withdrawn',
  cancelled: 'Cancelled',
};

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const asOfText = (iso: string) =>
  `As of ${new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;

function workbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  return wb;
}

async function buffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function title(ws: ExcelJS.Worksheet, lines: string[]) {
  lines.forEach((text, i) => {
    const c = ws.getCell(i + 1, 1);
    c.value = text;
    if (i === 0) c.font = { bold: true, size: 13 };
    else c.font = { color: { argb: 'FF555555' } };
  });
}

function boqLines(b: BoqHead, report: string, asOf: string) {
  return [
    `${report}: ${b.name}`,
    `${b.tender.number} · ${b.tender.title}${b.tender.client ? ` · ${b.tender.client}` : ''}`,
    `Version ${b.versionNo} (${b.status}), rates as on ${b.rateDate}. ${asOfText(asOf)}`,
  ];
}

function header(row: ExcelJS.Row, values: string[]) {
  row.values = values;
  row.font = { bold: true };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
}

export async function costSummaryXlsx(s: CostSummary): Promise<Buffer> {
  const wb = workbook();
  const ws = wb.addWorksheet('Cost summary');
  ws.columns = [
    { width: 14 },
    { width: 60 },
    { width: 18, style: { numFmt: MONEY } },
    { width: 10 },
  ];
  title(ws, boqLines(s.boq, 'Cost summary', s.asOf));
  let r = 5;
  header(ws.getRow(r++), ['Code', 'Section', 'Amount (₹)', '% of BOQ']);
  for (const x of s.sections)
    ws.getRow(r++).values = [x.code ?? '', x.description, num(x.amount), num(x.pct)];
  if (s.unsectioned.items > 0)
    ws.getRow(r++).values = [
      '',
      `Items outside sections (${s.unsectioned.items})`,
      num(s.unsectioned.amount),
      null,
    ];
  const t = ws.getRow(r++);
  t.values = ['', 'BOQ total', num(s.boq.total), s.sections.length ? 100 : null];
  t.font = { bold: true };

  r++;
  header(ws.getRow(r++), ['', 'What the BOQ is made of', 'Amount (₹)', '%']);
  for (const p of s.breakdown.parts)
    ws.getRow(r++).values = ['', PART_LABEL[p.part] ?? p.part, num(p.amount), num(p.pct)];
  ws.getRow(r++).values = [
    '',
    'Split in the proportions of each item’s rate analysis on the rate date.',
  ];
  if (s.incomplete.length)
    ws.getRow(r++).values = [
      '',
      `Analyses with resources missing a rate: ${s.incomplete.map((a) => `${a.code} (${a.missing.join(', ')})`).join('; ')}`,
    ];

  r++;
  header(ws.getRow(r++), ['', 'Items', 'Count', '']);
  for (const [label, n] of [
    ['Items', s.counts.items],
    ['Priced', s.counts.priced],
    ['Not priced', s.counts.unpriced],
    ['Without quantity', s.counts.noQty],
    ['Linked to a rate analysis', s.counts.analysed],
    ['Provisional sums (in the total)', s.kinds.provisional.items],
    ['Rate-only items (not in the total)', s.kinds.rateOnly.items],
    ['Alternates (not in the total)', s.kinds.alternates.items],
  ] as const) {
    const row = ws.getRow(r++);
    row.values = ['', label, n];
    row.getCell(3).numFmt = '0';
  }

  if (s.bid) {
    r++;
    header(ws.getRow(r++), ['', `Bid: ${s.bid.scenario}`, 'Amount (₹)', '%']);
    ws.getRow(r++).values = ['', 'BOQ value', num(s.bid.base)];
    for (const m of s.bid.markups) ws.getRow(r++).values = ['', m.label, num(m.amount), num(m.pct)];
    const b = ws.getRow(r++);
    b.values = ['', 'Before GST', num(s.bid.beforeGst)];
    b.font = { bold: true };
    ws.getRow(r++).values = [
      '',
      s.bid.gstMode === 'add'
        ? 'GST'
        : s.bid.gstMode === 'included'
          ? 'GST (in the rates)'
          : 'GST (exempt)',
      num(s.bid.gst),
    ];
    const g = ws.getRow(r++);
    g.values = ['', 'Bid', num(s.bid.bid)];
    g.font = { bold: true };
    if (s.bid.vsEstimatePct !== null)
      ws.getRow(r).values = [
        '',
        'Against the client’s estimate (before GST)',
        null,
        num(s.bid.vsEstimatePct),
      ];
  }
  return buffer(wb);
}

export async function analysisReportXlsx(rep: AnalysisReport): Promise<Buffer> {
  const wb = workbook();
  const ws = wb.addWorksheet('Rate analyses');
  ws.columns = [
    { width: 6 },
    { width: 14 },
    { width: 50 },
    { width: 8 },
    { width: 12 },
    { width: 10 },
    { width: 14, style: { numFmt: '#,##0.0000' } },
    { width: 16, style: { numFmt: MONEY } },
  ];
  title(ws, boqLines(rep.boq, 'Rate analyses', rep.asOf));
  let r = 5;
  if (rep.analyses.length === 0)
    ws.getRow(r).values = ['', 'No item of this BOQ is linked to a rate analysis.'];
  for (const a of rep.analyses) {
    const h = ws.getRow(r++);
    h.values = [
      '',
      a.code,
      `${a.description} — for ${a.outputQty} ${a.unit}${a.direct ? `; ${a.items} item${a.items === 1 ? '' : 's'} in this BOQ` : '; used inside other analyses'}`,
    ];
    h.font = { bold: true };
    header(ws.getRow(r++), [
      '#',
      'Code',
      'Description',
      'Unit',
      'Qty',
      'Wastage %',
      'Unit cost (₹)',
      'Cost (₹)',
    ]);
    for (const l of a.lines)
      ws.getRow(r++).values = [
        l.lineNo,
        l.code ?? (l.kind === 'lump_sum' ? 'Lump sum' : ''),
        l.description,
        l.unit ?? '',
        num(l.qty),
        num(l.wastagePct),
        num(l.unitCost),
        num(l.cost),
      ];
    ws.getRow(r++).values = ['', '', 'Subtotal', '', '', '', null, num(a.subtotal)];
    for (const x of a.additions)
      ws.getRow(r++).values = ['', '', `${x.label} (${x.pct} %)`, '', '', '', null, num(x.amount)];
    const tot = ws.getRow(r++);
    tot.values = ['', '', `Total for ${a.outputQty} ${a.unit}`, '', '', '', null, num(a.total)];
    tot.font = { bold: true };
    const rate = ws.getRow(r++);
    rate.values = ['', '', `Rate per ${a.unit}`, '', '', '', num(a.unitRate), num(a.boqRate)];
    rate.font = { bold: true };
    if (a.missing.length)
      ws.getRow(r++).values = [
        '',
        '',
        `No rate on ${rep.boq.rateDate} for ${a.missing.join(', ')}`,
      ];
    if (a.error) ws.getRow(r++).values = ['', '', a.error];
    r++;
  }
  return buffer(wb);
}

export async function pipelineXlsx(p: Pipeline): Promise<Buffer> {
  const wb = workbook();
  const ws = wb.addWorksheet('Bid pipeline', { views: [{ state: 'frozen', ySplit: 5 }] });
  const priced = !p.pricingHidden;
  ws.columns = [
    { width: 18 },
    { width: 44 },
    { width: 26 },
    { width: 11 },
    { width: 12 },
    { width: 18 },
    { width: 16, style: { numFmt: MONEY } },
    { width: 18 },
    ...(priced ? [{ width: 16, style: { numFmt: MONEY } }] : []),
    { width: 12 },
    { width: 16, style: { numFmt: MONEY } },
    { width: 24 },
  ];
  const filters = [
    p.filter.fy ? `FY ${p.filter.fy}` : 'All years',
    p.filter.status && p.filter.status !== 'all'
      ? `status: ${STATUS_LABEL[p.filter.status] ?? p.filter.status}`
      : null,
    p.filter.vertical ? `vertical: ${p.filter.vertical}` : null,
    p.filter.ownerId
      ? `owner: ${p.owners.find((o) => o.id === p.filter.ownerId)?.name ?? ''}`
      : null,
  ].filter(Boolean);
  title(ws, [
    'Bid pipeline',
    `${filters.join(', ')} · ${p.totals.tenders} tenders, ${p.totals.open} open, pipeline ₹${Number(p.totals.pipelineValue).toLocaleString('en-IN')}`,
    asOfText(p.asOf),
  ]);
  header(ws.getRow(5), [
    'Number',
    'Title',
    'Client',
    'Vertical',
    'Status',
    'Owner',
    'Estimate (₹)',
    'Submission due',
    ...(priced ? ['Our bid (₹)'] : []),
    'Result on',
    'Awarded (₹)',
    'Awarded to',
  ]);
  p.rows.forEach((x, i) => {
    ws.getRow(6 + i).values = [
      x.number,
      x.title,
      x.client ?? '',
      x.vertical,
      STATUS_LABEL[x.status] ?? x.status,
      x.owner ?? '',
      num(x.estimatedValue),
      x.submissionDueAt
        ? new Date(x.submissionDueAt).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
          })
        : '',
      ...(priced ? [num(x.ourBid)] : []),
      x.resultOn ?? '',
      num(x.awardedValue),
      x.awardedTo ?? '',
    ];
  });

  const st = wb.addWorksheet('By stage');
  st.columns = [{ width: 16 }, { width: 10 }, { width: 18, style: { numFmt: MONEY } }];
  header(st.getRow(1), ['Stage', 'Tenders', 'Estimate (₹)']);
  p.stages.forEach((s, i) => {
    st.getRow(2 + i).values = [STATUS_LABEL[s.status] ?? s.status, s.count, num(s.estimatedValue)];
  });
  return buffer(wb);
}
