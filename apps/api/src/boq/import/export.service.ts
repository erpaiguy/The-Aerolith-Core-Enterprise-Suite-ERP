// BOQ export to Excel or CSV (docs/wave1-plan.md step 4). Streams: rows are read 5,000 at a time in tree order and
// written as they come, so a million-line BOQ never sits in memory. The columns are exactly what the importer's
// "level" structure reads, so an exported file imports back unchanged.
import { PassThrough, Readable } from 'node:stream';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../../auth/auth.service.js';
import { TenantConnections } from '../../provisioning/tenant-connections.js';
import { csvCell } from './import.service.js';

const PAGE = 5000;
export const EXPORT_COLUMNS = [
  'Level',
  'Type',
  'Code',
  'Description',
  'Unit',
  'Qty',
  'Rate',
  'Amount',
  'Notes',
];

interface ExportRow {
  sort_key: string;
  depth: number;
  node_type: 'section' | 'item' | 'note';
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  amount: string | null;
  subtotal: string;
}

@Injectable()
export class ExportService {
  private readonly log = new Logger(ExportService.name);

  constructor(private readonly tenants: TenantConnections) {}

  async export(
    claims: TenantClaims,
    boqId: string,
    format: 'xlsx' | 'csv',
  ): Promise<{ stream: Readable; fileName: string; contentType: string }> {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<{ name: string; number: string; total: string }[]>`
      SELECT b.name, t.number, b.total::text AS total FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
      WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    const base = `${b.number} ${b.name}`.replace(/[^\w.\- ()&]+/g, '_').trim() || 'boq';
    const rows = pages(db, boqId);
    if (format === 'csv')
      return {
        stream: Readable.from(csvLines(rows)),
        fileName: `${base}.csv`,
        contentType: 'text/csv; charset=utf-8',
      };
    const out = new PassThrough();
    void writeXlsx(out, rows, b.name).catch((err: Error) => {
      this.log.error(`Export of BOQ ${boqId} failed: ${err.stack ?? err.message}`);
      out.destroy(err);
    });
    return {
      stream: out,
      fileName: `${base}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}

async function* pages(db: Sql, boqId: string): AsyncGenerator<ExportRow> {
  let after = '';
  for (;;) {
    const rows = await db<ExportRow[]>`
      SELECT n.sort_key, n.depth, n.node_type, n.code, t.description, t.notes, n.unit, n.qty::text AS qty,
        n.rate::text AS rate, n.amount::text AS amount, n.subtotal::text AS subtotal
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} AND n.sort_key > ${after}
      ORDER BY n.sort_key LIMIT ${PAGE}`;
    yield* rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.sort_key;
  }
}

/** Numbers as stored, without trailing zeros: 120.5000 -> 120.5. */
const plain = (v: string | null) =>
  v === null ? null : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

const valuesOf = (r: ExportRow) => [
  r.depth,
  r.node_type,
  r.code ?? '',
  r.description,
  r.unit ?? '',
  plain(r.qty),
  plain(r.rate),
  r.node_type === 'item' ? plain(r.amount) : r.node_type === 'section' ? plain(r.subtotal) : null,
  r.notes,
];

async function* csvLines(rows: AsyncGenerator<ExportRow>): AsyncGenerator<string> {
  yield '﻿' + EXPORT_COLUMNS.join(',') + '\r\n';
  let chunk = '';
  for await (const r of rows) {
    chunk += valuesOf(r).map(csvCell).join(',') + '\r\n';
    if (chunk.length > 64 * 1024) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}

async function writeXlsx(out: PassThrough, rows: AsyncGenerator<ExportRow>, name: string) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  wb.creator = 'Aerolith Core';
  const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'BOQ', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { outlineLevelRow: 7 } as Partial<ExcelJS.WorksheetProperties>,
  });
  ws.columns = [
    { key: 'level', width: 7 },
    { key: 'type', width: 9 },
    { key: 'code', width: 12 },
    { key: 'description', width: 70 },
    { key: 'unit', width: 9 },
    { key: 'qty', width: 12 },
    { key: 'rate', width: 12 },
    { key: 'amount', width: 16, style: { numFmt: '#,##0.00' } },
    { key: 'notes', width: 40 },
  ];
  const header = ws.addRow(EXPORT_COLUMNS);
  header.font = { bold: true };
  header.commit();
  for await (const r of rows) {
    const v = valuesOf(r);
    // Figures go in as numbers so the sheet can be summed; Excel keeps 15 significant digits, ample for 4 decimals.
    const row = ws.addRow(v.map((x, i) => (i >= 5 && i <= 7 && x !== null ? Number(x) : x)));
    if (r.depth > 0) row.outlineLevel = Math.min(7, r.depth);
    if (r.node_type === 'section') row.font = { bold: true };
    else if (r.node_type === 'note') row.font = { italic: true };
    row.commit();
    // Let the HTTP response drain instead of buffering the whole workbook.
    if (out.writableNeedDrain) await new Promise((res) => out.once('drain', res));
  }
  ws.commit();
  await wb.commit();
}
