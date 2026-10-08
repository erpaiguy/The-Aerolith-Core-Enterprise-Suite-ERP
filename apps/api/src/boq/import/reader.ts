// Streams rows out of an uploaded .xlsx or .csv file as plain text cells. Nothing is typed here: what a cell means is
// decided later, once the user has mapped columns (builder.ts).
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';

export interface RawRow {
  sheet: number;
  sheetName: string;
  rowNo: number;
  cells: string[];
}

export const MAX_COLUMNS = 100;
const MAX_CELL = 10_000;

/**
 * What an upload is, from its first bytes. xlsx files are zip archives ("PK\x03\x04"); old binary .xls files are OLE2
 * compound documents; text without NUL bytes is read as CSV. Anything else is refused before it is parsed.
 */
export async function sniffType(path: string): Promise<'xlsx' | 'csv' | 'xls' | 'pdf' | 'binary'> {
  const fh = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead);
    if (bytesRead >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'xlsx';
    if (bytesRead >= 8 && head.readBigUInt64BE(0) === 0xd0cf11e0a1b11ae1n) return 'xls';
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    // UTF-16 text (some exports) has NULs too, but is rare enough to ask for UTF-8 instead.
    return head.includes(0) ? 'binary' : 'csv';
  } finally {
    await fh.close();
  }
}

/** Plain text of a cell as Excel shows it: formulas give their result, rich text its characters. */
export function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('formula' in v || 'sharedFormula' in v) return '';
    if ('text' in v) return String(v.text);
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

// Postgres text cannot hold NUL, and JSON with a lone UTF-16 surrogate is rejected; neither means anything in a BOQ.
// eslint-disable-next-line no-control-regex -- matching NUL is the point
const BAD_CHARS = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const clean = (c: string) => {
  const t = c.length > MAX_CELL ? c.slice(0, MAX_CELL) : c;
  return t.replace(BAD_CHARS, '');
};

const tidy = (cells: string[]): string[] => {
  const out = cells.slice(0, MAX_COLUMNS).map(clean);
  while (out.length && out[out.length - 1]!.trim() === '') out.pop();
  return out;
};

/** Reports bytes read so far, for progress (the file is read front to back). */
export type OnBytes = (bytesRead: number) => void;

// Progress is read from bytesRead as rows come out; a 'data' listener would switch the stream to flowing mode and
// lose data before the parser is attached.
const fileStream = (path: string) => createReadStream(path, { highWaterMark: 256 * 1024 });

export async function* readXlsx(path: string, onBytes?: OnBytes): AsyncGenerator<RawRow> {
  const file = fileStream(path);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'emit',
  });
  let sheet = 0;
  try {
    for await (const ws of reader) {
      const sheetName =
        (ws as unknown as { name?: string }).name?.toString() || `Sheet ${sheet + 1}`;
      for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
        const values = row.values as ExcelJS.CellValue[]; // 1-based
        const cells = tidy(Array.from(values.slice(1), (v) => cellText(v))); // sparse: holes are empty cells
        onBytes?.(file.bytesRead);
        if (cells.length) yield { sheet, sheetName, rowNo: row.number, cells };
      }
      sheet++;
    }
  } finally {
    file.destroy(); // the caller may stop early (one sheet only)
  }
}

/** Picks the delimiter that appears most in the first lines: comma, semicolon or tab. */
async function sniffDelimiter(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
    const head = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split(/\r?\n/)
      .slice(0, 5)
      .join('\n');
    const counts = [',', ';', '\t'].map((d) => [d, head.split(d).length - 1] as const);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0]![1] > 0 ? counts[0]![0] : ',';
  } finally {
    await fh.close();
  }
}

// Our CSV export guards text that a spreadsheet would run as a formula with a leading apostrophe; undo that.
const unguard = (c: string) => (/^'[=+@\t\r]/.test(c) ? c.slice(1) : c);

export async function* readCsv(path: string, onBytes?: OnBytes): AsyncGenerator<RawRow> {
  const delimiter = await sniffDelimiter(path);
  const file = fileStream(path);
  const parser = file.pipe(
    parse({
      bom: true,
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      info: true,
    }),
  );
  try {
    for await (const rec of parser as AsyncIterable<{
      record: string[];
      info: { records: number };
    }>) {
      const cells = tidy(rec.record.map(unguard));
      onBytes?.(file.bytesRead);
      // Records, not text lines: a quoted multi-line cell is one row, as a spreadsheet shows it.
      if (cells.length) yield { sheet: 0, sheetName: 'CSV', rowNo: rec.info.records, cells };
    }
  } finally {
    file.destroy();
  }
}

export function readRows(path: string, type: 'xlsx' | 'csv', onBytes?: OnBytes) {
  return type === 'xlsx' ? readXlsx(path, onBytes) : readCsv(path, onBytes);
}
