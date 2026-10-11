// The procurement reports as Excel workbooks (docs/wave2b-plan.md step 9): the same rows as the screen, numbers as
// numbers so they sum, with what the report is and when it was made.
import ExcelJS from 'exceljs';

export interface Column<T> {
  header: string;
  value: (row: T) => string | number | null;
  /** Numbers are written as numbers, with this format. */
  format?: string;
  width?: number;
}

const QTY = '#,##0.####';
const MONEY = '#,##0.00';
export const qtyCol = <T>(header: string, value: (r: T) => string | null): Column<T> => ({
  header,
  value: (r) => (value(r) === null ? null : Number(value(r))),
  format: QTY,
  width: 12,
});
export const moneyCol = <T>(header: string, value: (r: T) => string | null): Column<T> => ({
  header,
  value: (r) => (value(r) === null ? null : Number(value(r))),
  format: MONEY,
  width: 14,
});

/** One sheet: two lines saying what it is, a header row, the rows. */
export async function reportXlsx<T>(
  sheet: string,
  lines: string[],
  columns: Column<T>[],
  rows: T[],
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const ws = wb.addWorksheet(sheet.slice(0, 31));
  const asOf = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  [...lines, `As of ${asOf} IST`].forEach((text, i) => {
    const c = ws.getCell(i + 1, 1);
    c.value = text;
    c.font = i === 0 ? { bold: true, size: 13 } : { color: { argb: 'FF555555' } };
  });
  const head = ws.getRow(lines.length + 3);
  head.values = columns.map((c) => c.header);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? 18;
    if (c.format) ws.getColumn(i + 1).numFmt = c.format;
  });
  for (const r of rows) ws.addRow(columns.map((c) => c.value(r)));
  ws.views = [{ state: 'frozen', ySplit: lines.length + 3 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
