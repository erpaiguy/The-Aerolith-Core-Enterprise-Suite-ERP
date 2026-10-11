// The enquiry pack as an Excel workbook, one per vendor, and reading it back filled in (docs/wave1-plan.md step 9).
// Vendors cannot sign in to the app, and the system mailbox is the platform's, not the contractor's, so the estimator
// sends the file from their own email and imports the reply. A hidden sheet carries the RFQ and vendor ids; lines are
// matched by their number in column A, so a vendor who copies the rows into a fresh sheet is still understood.
import ExcelJS from 'exceljs';
import { readNumber } from '../boq/import/builder.js';
import { parseDate } from '../rates/price-book.js';
import type { GstMode } from './rfq-rules.js';

const SHEET = 'Enquiry';
const META = '_aerolith';
const HEADER = [
  'S.No',
  'Code',
  'Description',
  'Unit',
  'Quantity',
  'Rate (₹)',
  'Amount (₹)',
  'Remarks',
];
const FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } as const;
const LABEL = {
  reference: 'Your quote reference',
  validUntil: 'Valid until',
  gst: 'GST',
  gstPct: 'GST rate %',
};
const GST_CHOICES = ['Extra on top of the rates', 'Included in the rates', 'Exempt'];

export interface PackInput {
  rfq: { id: string; number: string; title: string; dueOn: string | null; terms: string };
  /** What it is for: the tender (Wave 1) or the project (Wave 2b). */
  owner: { label: 'Tender' | 'Project'; number: string; title: string };
  vendor: { id: string; name: string };
  lines: {
    seq: number;
    code: string | null;
    description: string;
    unit: string | null;
    qty: string | null;
  }[];
}

export async function enquiryWorkbook(p: PackInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 15 }] });
  ws.columns = [
    { width: 7 },
    { width: 12 },
    { width: 60 },
    { width: 9 },
    { width: 12 },
    { width: 14 },
    { width: 16 },
    { width: 30 },
  ];
  ws.getCell('A1').value = 'Request for quotation';
  ws.getCell('A1').font = { bold: true, size: 14 };
  const facts: [string, string][] = [
    ['RFQ', p.rfq.number],
    ['For', p.rfq.title],
    [p.owner.label, `${p.owner.number} · ${p.owner.title}`],
    ['To', p.vendor.name],
    ['Quotes due by', p.rfq.dueOn ?? ''],
    ['Terms', p.rfq.terms],
  ];
  facts.forEach(([k, v], i) => {
    const row = ws.getRow(2 + i);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    ws.mergeCells(2 + i, 2, 2 + i, 8);
    row.getCell(2).value = v;
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  });
  ws.getCell('A9').value =
    'Please fill in the yellow cells (rates before GST unless you say otherwise) and return this file.';
  ws.getCell('A9').font = { italic: true };
  const ask: [string, ExcelJS.CellValue][] = [
    [LABEL.reference, ''],
    [LABEL.validUntil, ''],
    [LABEL.gst, GST_CHOICES[0]!],
    [LABEL.gstPct, 18],
  ];
  ask.forEach(([k, v], i) => {
    const row = ws.getRow(10 + i);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    ws.mergeCells(10 + i, 1, 10 + i, 2);
    const cell = row.getCell(3);
    cell.value = v;
    cell.fill = FILL;
  });
  ws.getCell('C12').dataValidation = {
    type: 'list',
    allowBlank: false,
    formulae: [`"${GST_CHOICES.join(',')}"`],
  };
  const head = ws.getRow(15);
  HEADER.forEach((h, i) => {
    head.getCell(i + 1).value = h;
    head.getCell(i + 1).font = { bold: true };
    head.getCell(i + 1).border = { bottom: { style: 'thin' } };
  });
  p.lines.forEach((l, i) => {
    const r = 16 + i;
    const row = ws.getRow(r);
    row.values = [
      l.seq,
      l.code ?? '',
      l.description,
      l.unit ?? '',
      l.qty === null ? null : Number(l.qty),
    ];
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(6).fill = FILL;
    row.getCell(6).numFmt = '#,##0.00';
    row.getCell(7).value = l.qty === null ? null : { formula: `IF(F${r}="","",E${r}*F${r})` };
    row.getCell(7).numFmt = '#,##0.00';
    row.getCell(8).fill = FILL;
  });
  const meta = wb.addWorksheet(META, { state: 'veryHidden' });
  meta.addRows([
    ['rfq', p.rfq.id],
    ['vendor', p.vendor.id],
    ['format', 1],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ReadQuote {
  rfqId: string | null;
  vendorId: string | null;
  reference: string | null;
  validUntil: string | null;
  gstMode: GstMode;
  gstPct: string;
  lines: { seq: number; rate: string; remark: string }[];
  /** Rows with no rate: the vendor did not price them. */
  skipped: number;
  issues: string[];
}

/** Text of a cell as a person reads it: formulas by their result, rich text joined, dates as YYYY-MM-DD. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v).trim();
}

const gstModeOf = (t: string): GstMode =>
  /exempt|nil/i.test(t) ? 'exempt' : /incl/i.test(t) ? 'included' : 'extra';

export async function readQuoteWorkbook(buffer: Buffer): Promise<ReadQuote> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new Error(
      'This file could not be read as an Excel workbook. Save it as .xlsx and try again.',
    );
  }
  const meta = wb.getWorksheet(META);
  const metaValue = (key: string) => {
    if (!meta) return null;
    for (let r = 1; r <= meta.rowCount; r++)
      if (cellText(meta.getRow(r).getCell(1).value) === key)
        return cellText(meta.getRow(r).getCell(2).value) || null;
    return null;
  };
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets.find((s) => s.name !== META);
  if (!ws) throw new Error('The workbook has no sheet with the enquiry.');

  const out: ReadQuote = {
    rfqId: metaValue('rfq'),
    vendorId: metaValue('vendor'),
    reference: null,
    validUntil: null,
    gstMode: 'extra',
    gstPct: '18',
    lines: [],
    skipped: 0,
    issues: [],
  };
  // The questions at the top are found by their labels in column A, wherever the vendor left them.
  let headerRow = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 60); r++) {
    const row = ws.getRow(r);
    const label = cellText(row.getCell(1).value).toLowerCase();
    // The answer is in C; a vendor may type it in B instead, unless B is merged into the label (the pack merges
    // A:B, and a merged cell reads as the label itself).
    const b = row.getCell(2);
    const answer =
      cellText(row.getCell(3).value) ||
      (b.isMerged && b.master.address !== b.address ? '' : cellText(b.value));
    if (label === LABEL.reference.toLowerCase()) out.reference = answer.slice(0, 100) || null;
    else if (label === LABEL.validUntil.toLowerCase() && answer) {
      out.validUntil = parseDate(answer);
      if (!out.validUntil)
        out.issues.push(`"Valid until" (${answer}) is not a date; it was left out.`);
    } else if (label === LABEL.gst.toLowerCase() && answer) out.gstMode = gstModeOf(answer);
    else if (label === LABEL.gstPct.toLowerCase() && answer) {
      const n = readNumber(answer.replace('%', ''));
      if ('error' in n || n.value === null || Number(n.value) > 100 || Number(n.value) < 0)
        out.issues.push(`GST rate "${answer}" is not a percentage.`);
      else out.gstPct = n.value;
    } else if (label === 's.no') {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) throw new Error('No "S.No" heading found: is this the enquiry workbook?');

  let blank = 0;
  for (let r = headerRow + 1; r <= ws.rowCount && blank < 5; r++) {
    const row = ws.getRow(r);
    const seqText = cellText(row.getCell(1).value);
    if (!seqText) {
      blank++;
      continue;
    }
    blank = 0;
    const seq = Number(seqText);
    if (!Number.isInteger(seq) || seq <= 0) continue; // a note or subtotal row the vendor added
    const rateText = cellText(row.getCell(6).value);
    const remark = cellText(row.getCell(8).value).slice(0, 1000);
    if (!rateText) {
      out.skipped++;
      continue;
    }
    const n = readNumber(rateText);
    if ('error' in n || n.value === null || n.value.startsWith('-'))
      out.issues.push(`Line ${seq}: rate "${rateText}" is not a number.`);
    else out.lines.push({ seq, rate: n.value, remark });
  }
  return out;
}
