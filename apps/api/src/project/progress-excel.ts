// The progress report as an Excel workbook (docs/wave2a-plan.md step 7): the same figures as the screen, as numbers
// that sum, by contract BOQ and its sections, and by WBS element.
import ExcelJS from 'exceljs';
import type { ProgressService } from './progress.service.js';

type Report = Awaited<ReturnType<ProgressService['report']>>;
type Done = Report['total'];

const MONEY = '#,##0.00';
const PCT = '0.0"%"';
const num = (v: string) => Number(v);

const HEAD = [
  'Code',
  'Description',
  'Contract value',
  'Value done',
  'Physical %',
  'This period',
  'Same work at budget rates',
  'Items',
  'Items started',
  'Items beyond BOQ quantity',
];

function sheet(wb: ExcelJS.Workbook, name: string, title: string[]) {
  const ws = wb.addWorksheet(name);
  ws.columns = [
    { width: 14 },
    { width: 56 },
    { width: 18, style: { numFmt: MONEY } },
    { width: 18, style: { numFmt: MONEY } },
    { width: 11, style: { numFmt: PCT } },
    { width: 18, style: { numFmt: MONEY } },
    { width: 18, style: { numFmt: MONEY } },
    { width: 8 },
    { width: 9 },
    { width: 12 },
  ];
  title.forEach((text, i) => {
    const c = ws.getCell(i + 1, 1);
    c.value = text;
    c.font = i === 0 ? { bold: true, size: 13 } : { color: { argb: 'FF555555' } };
  });
  const head = ws.getRow(title.length + 2);
  head.values = HEAD;
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  ws.views = [{ state: 'frozen', ySplit: title.length + 2 }];
  return ws;
}

function line(
  ws: ExcelJS.Worksheet,
  code: string | null,
  description: string,
  d: Done,
  bold = false,
) {
  const r = ws.addRow([
    code ?? '',
    description,
    num(d.value),
    num(d.done),
    d.pct,
    num(d.period),
    num(d.budgetDone),
    d.items,
    d.itemsStarted,
    d.itemsOver,
  ]);
  if (bold) r.font = { bold: true };
}

export async function progressXlsx(
  project: { number: string; name: string },
  r: Report,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const title = [
    `Progress: ${project.number} ${project.name}`,
    `Work done to ${r.to}; this period ${r.from} to ${r.to}. Value at contract rates; physical progress within the BOQ quantities.`,
  ];
  const ws = sheet(wb, 'By BOQ section', title);
  for (const b of r.boqs) {
    ws.addRow([]);
    ws.addRow([b.name]).font = { bold: true };
    for (const s of b.sections) line(ws, s.code, s.description, s);
    line(ws, null, `Total ${b.name}`, b, true);
  }
  ws.addRow([]);
  line(ws, null, 'Project total', r.total, true);

  if (r.wbs.length) {
    const w = sheet(wb, 'By WBS', title);
    for (const n of r.wbs) {
      line(w, n.code, `${'  '.repeat(n.depth)}${n.name}`, n, n.depth === 0);
      w.lastRow!.getCell(2).alignment = { indent: n.depth * 2 };
    }
    if (r.unmapped) line(w, null, 'No WBS element', r.unmapped);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
