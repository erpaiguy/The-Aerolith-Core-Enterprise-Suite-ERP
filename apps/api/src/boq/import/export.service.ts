// BOQ export to Excel or CSV (docs/wave1-plan.md step 4). Streams: rows are read 5,000 at a time in tree order and
// written as they come, so a million-line BOQ never sits in memory. The columns are exactly what the importer's
// "level" structure reads, so an exported file imports back unchanged.
//
// With a pricing scenario (step 6) two columns follow: each item's rate loaded with the scenario's markups
// (rate × factor, rounded to paise) and its amount, for item-rate tenders where the submitted rates must add up to
// the bid. That needs the pricing permission.
import { PassThrough, Readable } from 'node:stream';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../../auth/auth.service.js';
import { PermissionsService } from '../../auth/permissions.js';
import { PricingService } from '../../pricing/pricing.service.js';
import { RevisionService } from '../revision.service.js';
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
const QUOTED_COLUMNS = ['Quoted rate', 'Quoted amount'];

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
  quoted_rate?: string | null;
  quoted_amount?: string | null;
}

@Injectable()
export class ExportService {
  private readonly log = new Logger(ExportService.name);

  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly pricing: PricingService,
    private readonly revisions: RevisionService,
  ) {}

  async export(
    claims: TenantClaims,
    boqId: string,
    format: 'xlsx' | 'csv',
    scenarioId?: string | undefined,
    version?: number | undefined,
  ): Promise<{ stream: Readable; fileName: string; contentType: string }> {
    let quote: { name: string; factor: string } | null = null;
    if (scenarioId) {
      if (!(await this.permissions.can(claims, 'pricing.edit')))
        throw new ForbiddenException({
          code: 'forbidden',
          permission: 'pricing.edit',
          message: 'Your role does not allow seeing bid pricing. Ask your admin.',
        });
      quote = await this.pricing.factorFor(claims, boqId, scenarioId);
    }
    const db = await this.tenants.forTenant(claims.ten);
    const old = await this.revisions.exportVersion(db, boqId, version);
    if (old !== null && quote)
      throw new BadRequestException({
        code: 'quoted_current_only',
        message: 'Quoted rates come from the current version only.',
      });
    const [b] = await db<{ name: string; number: string; total: string }[]>`
      SELECT b.name, t.number, b.total::text AS total FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id
      WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    const base =
      `${b.number} ${b.name}${old !== null ? ` - version ${old}` : ''}${quote ? ` - quoted (${quote.name})` : ''}`
        .replace(/[^\w.\- ()&]+/g, '_')
        .trim() || 'boq';
    const rows =
      old !== null
        ? this.revisions.versionRows(db, boqId, old)
        : pages(db, boqId, quote?.factor ?? null);
    const quoted = quote !== null;
    if (format === 'csv')
      return {
        stream: Readable.from(csvLines(rows, quoted)),
        fileName: `${base}.csv`,
        contentType: 'text/csv; charset=utf-8',
      };
    const out = new PassThrough();
    void writeXlsx(out, rows, b.name, quoted).catch((err: Error) => {
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

async function* pages(db: Sql, boqId: string, factor: string | null): AsyncGenerator<ExportRow> {
  let after = '';
  const quoted = factor
    ? db`, round(n.rate * ${factor}::numeric, 2)::text AS quoted_rate,
        round(n.qty * round(n.rate * ${factor}::numeric, 2), 2)::text AS quoted_amount`
    : db``;
  for (;;) {
    const rows = await db<ExportRow[]>`
      SELECT n.sort_key, n.depth, n.node_type, n.code, t.description, t.notes, n.unit, n.qty::text AS qty,
        n.rate::text AS rate, n.amount::text AS amount, n.subtotal::text AS subtotal ${quoted}
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

const valuesOf = (r: ExportRow, quoted = false) => [
  r.depth,
  r.node_type,
  r.code ?? '',
  r.description,
  r.unit ?? '',
  plain(r.qty),
  plain(r.rate),
  r.node_type === 'item' ? plain(r.amount) : r.node_type === 'section' ? plain(r.subtotal) : null,
  r.notes,
  ...(quoted
    ? r.node_type === 'item'
      ? [plain(r.quoted_rate ?? null), plain(r.quoted_amount ?? null)]
      : [null, null]
    : []),
];

async function* csvLines(rows: AsyncGenerator<ExportRow>, quoted: boolean): AsyncGenerator<string> {
  yield '﻿' + [...EXPORT_COLUMNS, ...(quoted ? QUOTED_COLUMNS : [])].join(',') + '\r\n';
  let chunk = '';
  for await (const r of rows) {
    chunk += valuesOf(r, quoted).map(csvCell).join(',') + '\r\n';
    if (chunk.length > 64 * 1024) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}

async function writeXlsx(
  out: PassThrough,
  rows: AsyncGenerator<ExportRow>,
  name: string,
  quoted: boolean,
) {
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
    ...(quoted
      ? [
          { key: 'quotedRate', width: 13 },
          { key: 'quotedAmount', width: 16, style: { numFmt: '#,##0.00' } },
        ]
      : []),
  ];
  const header = ws.addRow([...EXPORT_COLUMNS, ...(quoted ? QUOTED_COLUMNS : [])]);
  header.font = { bold: true };
  header.commit();
  for await (const r of rows) {
    const v = valuesOf(r, quoted);
    // Figures go in as numbers so the sheet can be summed; Excel keeps 15 significant digits, ample for 4 decimals.
    const row = ws.addRow(
      v.map((x, i) => (((i >= 5 && i <= 7) || i >= 9) && x !== null && x !== '' ? Number(x) : x)),
    );
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
