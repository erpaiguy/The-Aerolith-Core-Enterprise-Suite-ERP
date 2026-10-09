// A dashboard as Excel: the tiles on the first sheet, then one sheet per chart with the figures behind it.
import ExcelJS from 'exceljs';
import type { AnyDashboard, Tile } from './dashboard.service.js';

const MONEY = '#,##0.00';
const n = (v: string | null) => (v === null || v === '' ? null : Number(v));

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  head: string[],
  rows: unknown[][],
  money: number[] = [],
) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = head.map((h, i) => ({
    header: h,
    width: Math.max(12, h.length + 4, i === 0 ? 24 : 0),
    ...(money.includes(i) ? { style: { numFmt: MONEY } } : {}),
  }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
}

const tileRow = (t: Tile) => [
  t.label,
  t.value === '' ? null : Number(t.value),
  t.kind === 'money' ? '₹' : t.kind === 'pct' ? '%' : '',
  t.detail ?? '',
  t.hint,
];

export async function dashboardXlsx(d: AnyDashboard): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const title = d.dashboard === 'tender' ? 'Tender and bid dashboard' : 'Estimation dashboard';
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { width: 34 },
    { width: 18, style: { numFmt: '#,##0.##' } },
    { width: 6 },
    { width: 30 },
    { width: 70 },
  ];
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A2').value = `FY ${d.filter.fy}${d.filter.vertical ? ` · ${d.filter.vertical}` : ''}${
    d.filter.ownerId ? ` · ${d.owners.find((o) => o.id === d.filter.ownerId)?.name ?? ''}` : ''
  } · as of ${new Date(d.asOf).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;
  ws.getRow(4).values = ['Tile', 'Value', '', 'Detail', 'What it counts'];
  ws.getRow(4).font = { bold: true };
  [...d.fixed, ...d.tiles].forEach((t, i) => (ws.getRow(5 + i).values = tileRow(t)));

  if (d.dashboard === 'tender') {
    const c = d.charts;
    sheet(
      wb,
      'By stage',
      ['Stage', 'Tenders', 'Estimate (₹)'],
      c.stages.map((s) => [s.status, s.count, n(s.estimatedValue)]),
      [2],
    );
    sheet(
      wb,
      'By quarter',
      ['Quarter', 'Submitted', 'Won', 'Lost', 'Won value (₹)'],
      c.quarters.map((q) => [q.quarter, q.submitted, q.won, q.lost, n(q.wonValue)]),
      [4],
    );
    sheet(
      wb,
      'By vertical',
      ['Vertical', 'Open', 'Won', 'Lost'],
      c.verticals.map((v) => [v.vertical, v.open, v.won, v.lost]),
    );
    sheet(
      wb,
      'Next 30 days',
      ['When', 'What', 'Tender', 'Title'],
      c.upcoming.map((u) => [new Date(u.at), u.label, u.tender.number, u.tender.title]),
    );
    sheet(
      wb,
      'Open RFQs',
      ['RFQ', 'Title', 'Tender', 'Quotes due', 'Vendors', 'Quotes in'],
      c.rfqs.map((r) => [r.number, r.title, r.tender.number, r.dueOn ?? '', r.vendors, r.quoted]),
    );
  } else {
    const c = d.charts;
    sheet(
      wb,
      'By estimator',
      ['Estimator', 'BOQs', 'Value (₹)', 'Items not priced'],
      c.estimators.map((e) => [e.name, e.boqs, n(e.value), e.unpriced]),
      [2],
    );
    sheet(
      wb,
      'Largest BOQs',
      ['BOQ', 'Tender', 'Title', 'Version', 'Value (₹)'],
      c.topBoqs.map((b) => [b.name, b.tender.number, b.tender.title, b.versionNo, n(b.total)]),
      [4],
    );
    sheet(
      wb,
      'Revisions',
      [
        'BOQ',
        'Tender',
        'Versions',
        'First (₹)',
        'Latest frozen (₹)',
        'Now (₹)',
        'Change since first %',
      ],
      c.revisions.map((r) => [
        r.name,
        r.tenderNumber,
        r.versions,
        n(r.first),
        n(r.latest),
        n(r.current),
        n(r.changePct),
      ]),
      [3, 4, 5],
    );
    sheet(
      wb,
      'Cost breakdown',
      ['Part', 'Amount (₹)', '%'],
      c.breakdown.parts.map((p) => [p.part, n(p.amount), n(p.pct)]),
      [1],
    );
    sheet(
      wb,
      'Rate changes',
      ['Code', 'Resource', 'Unit', 'From', 'Rate (₹)', 'Previous (₹)', 'Change %'],
      c.rateChanges.map((r) => [
        r.code,
        r.name,
        r.unit,
        r.effectiveFrom,
        n(r.rate),
        n(r.previous),
        n(r.changePct),
      ]),
      [4, 5],
    );
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
