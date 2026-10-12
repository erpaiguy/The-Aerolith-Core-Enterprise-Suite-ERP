import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { moneyCol, type Column } from '../procurement/procurement-report-excel.js';
import { GstService, type InwardRow, type OutwardRow } from './gst.service.js';

const date = z.iso.date();
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM');
const format = z.object({ format: z.enum(['json', 'xlsx']).default('json') });
const kind = z.enum(['invoice', 'credit_note']);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sheets as the GSTR-1 offline tool's template heads them: one header row, then the rows. */
async function gstr1Workbook(
  sheets: { name: string; headers: string[]; rows: (string | number)[][] }[],
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    const head = ws.addRow(s.headers);
    head.font = { bold: true };
    s.headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(14, h.length + 2)));
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** One sheet of a register: what it is, a header row, the rows. */
function addSheet<T>(
  wb: ExcelJS.Workbook,
  name: string,
  lines: string[],
  columns: Column<T>[],
  rows: T[],
) {
  const ws = wb.addWorksheet(name);
  lines.forEach((text, i) => {
    ws.getCell(i + 1, 1).value = text;
    if (i === 0) ws.getCell(1, 1).font = { bold: true, size: 13 };
  });
  const head = ws.getRow(lines.length + 2);
  head.values = columns.map((c) => c.header);
  head.font = { bold: true };
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? 18;
    if (c.format) ws.getColumn(i + 1).numFmt = c.format;
  });
  for (const r of rows) ws.addRow(columns.map((c) => c.value(r)));
  ws.views = [{ state: 'frozen', ySplit: lines.length + 2 }];
}

/** GST (docs/wave3-plan.md step 6a). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class GstController {
  constructor(private readonly gst: GstService) {}

  @Post('client-bills/:id/credit-notes')
  @HttpCode(200)
  @RequiresFeatures()
  creditNote(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date,
          reason: z.string().trim().min(3).max(500),
          taxable: z
            .union([z.string().trim(), z.number()])
            .transform((v) => String(v).replace(/,/g, ''))
            .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v) && Number(v) > 0, {
              message: 'A value more than nothing',
            }),
        }),
      ),
    )
    b: { date: string; reason: string; taxable: string },
  ) {
    return this.gst.creditNote(c, id, b);
  }

  @Get('client-bills/:id/gst')
  async forBill(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.gst.billGst(c, id);
  }

  @Get('credit-notes/:id')
  creditNoteById(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.gst.creditNoteById(c, id);
  }

  @Get('accounts/gst/registers')
  async registers(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(format.extend({ entityId: z.uuid(), from: date, to: date })))
    q: { format: 'json' | 'xlsx'; entityId: string; from: string; to: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.gst.registers(c, q);
    if (q.format === 'json') return r;
    const sign = (row: { kind: string }, v: string) =>
      (row.kind === 'credit_note' || row.kind === 'debit_note' ? -1 : 1) * Number(v);
    const out: Column<OutwardRow>[] = [
      {
        header: 'Kind',
        value: (x) => (x.kind === 'invoice' ? 'Invoice' : 'Credit note'),
        width: 12,
      },
      { header: 'Number', value: (x) => x.number, width: 20 },
      { header: 'Date', value: (x) => x.date, width: 12 },
      { header: 'Client', value: (x) => x.party, width: 30 },
      { header: 'GSTIN', value: (x) => x.gstin, width: 18 },
      { header: 'Place of supply', value: (x) => x.pos, width: 8 },
      { header: 'Rate %', value: (x) => Number(x.rate), width: 8 },
      moneyCol('Taxable', (x) => String(sign(x, x.taxable))),
      moneyCol('CGST', (x) => String(sign(x, x.cgst))),
      moneyCol('SGST', (x) => String(sign(x, x.sgst))),
      moneyCol('IGST', (x) => String(sign(x, x.igst))),
      moneyCol('Total', (x) => String(sign(x, x.total))),
    ];
    const inw: Column<InwardRow>[] = [
      { header: 'Kind', value: (x) => (x.kind === 'bill' ? 'Bill' : 'Debit note'), width: 12 },
      { header: 'Supplier', value: (x) => x.party, width: 30 },
      { header: 'GSTIN', value: (x) => x.gstin, width: 18 },
      { header: 'Bill no.', value: (x) => x.billNo, width: 20 },
      { header: 'Date', value: (x) => x.date, width: 12 },
      moneyCol('Taxable', (x) => String(sign(x, x.taxable))),
      moneyCol('CGST', (x) => String(sign(x, x.cgst))),
      moneyCol('SGST', (x) => String(sign(x, x.sgst))),
      moneyCol('IGST', (x) => String(sign(x, x.igst))),
      moneyCol('Total', (x) => String(sign(x, x.total))),
      moneyCol('Input tax blocked', (x) => x.blocked),
    ];
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aerolith Core';
    addSheet(wb, 'Outward', [`GST outward register`, `${q.from} to ${q.to}`], out, r.outward);
    addSheet(wb, 'Inward', [`GST inward register`, `${q.from} to ${q.to}`], inw, r.inward);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()), {
      type: XLSX,
      disposition: attachment(`GST-registers-${q.from}-${q.to}.xlsx`),
    });
  }

  @Get('accounts/gst/gstr1')
  async gstr1(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(format.extend({ entityId: z.uuid(), period })))
    q: { format: 'json' | 'xlsx'; entityId: string; period: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.gst.gstr1(c, q);
    if (q.format === 'json') return r;
    const n = Number;
    const hsnHead = [
      'HSN',
      'Description',
      'UQC',
      'Total Quantity',
      'Total Value',
      'Rate',
      'Taxable Value',
      'Integrated Tax Amount',
      'Central Tax Amount',
      'State/UT Tax Amount',
      'Cess Amount',
    ];
    const hsnRows = (rows: typeof r.hsnB2b) =>
      rows.map((h) => [
        h.hsn,
        h.description,
        h.uqc,
        n(h.quantity),
        n(h.value),
        n(h.rate),
        n(h.taxable),
        n(h.igst),
        n(h.cgst),
        n(h.sgst),
        n(h.cess),
      ]);
    const buf = await gstr1Workbook([
      {
        name: 'b2b',
        headers: [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Reverse Charge',
          'Applicable % of Tax Rate',
          'Invoice Type',
          'E-Commerce GSTIN',
          'Rate',
          'Taxable Value',
          'Cess Amount',
        ],
        rows: r.b2b.map((x) => [
          x.gstin,
          x.receiver,
          x.number,
          x.date,
          n(x.value),
          x.pos,
          x.reverseCharge,
          x.applicablePct,
          x.invoiceType,
          x.ecommerceGstin,
          n(x.rate),
          n(x.taxable),
          n(x.cess),
        ]),
      },
      {
        name: 'b2cl',
        headers: [
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
          'E-Commerce GSTIN',
        ],
        rows: r.b2cl.map((x) => [
          x.number,
          x.date,
          n(x.value),
          x.pos,
          x.applicablePct,
          n(x.rate),
          n(x.taxable),
          n(x.cess),
          x.ecommerceGstin,
        ]),
      },
      {
        name: 'b2cs',
        headers: [
          'Type',
          'Place Of Supply',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
          'E-Commerce GSTIN',
        ],
        rows: r.b2cs.map((x) => [
          x.type,
          x.pos,
          x.applicablePct,
          n(x.rate),
          n(x.taxable),
          n(x.cess),
          x.ecommerceGstin,
        ]),
      },
      {
        name: 'cdnr',
        headers: [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Note Number',
          'Note Date',
          'Note Type',
          'Place Of Supply',
          'Reverse Charge',
          'Note Supply Type',
          'Note Value',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
        ],
        rows: r.cdnr.map((x) => [
          x.gstin,
          x.receiver,
          x.number,
          x.date,
          x.noteType,
          x.pos,
          x.reverseCharge,
          x.supplyType,
          n(x.value),
          x.applicablePct,
          n(x.rate),
          n(x.taxable),
          n(x.cess),
        ]),
      },
      { name: 'hsn(b2b)', headers: hsnHead, rows: hsnRows(r.hsnB2b) },
      { name: 'hsn(b2c)', headers: hsnHead, rows: hsnRows(r.hsnB2c) },
      {
        name: 'docs',
        headers: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
        rows: r.docs.map((d) => [d.nature, d.from, d.to, d.total, d.cancelled]),
      },
    ]);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(buf, {
      type: XLSX,
      disposition: attachment(`GSTR-1-${q.period}.xlsx`),
    });
  }

  @Get('accounts/gst/gstr3b')
  gstr3b(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), period })))
    q: { entityId: string; period: string },
  ) {
    return this.gst.gstr3b(c, q);
  }

  @Get('accounts/e-invoices/:kind/:id/json')
  async eInvoiceJson(
    @Auth() c: TenantClaims,
    @Param('kind', new ZodPipe(kind)) k: 'invoice' | 'credit_note',
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.gst.eInvoiceJson(c, k, id);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(JSON.stringify([r.json], null, 2)), {
      type: 'application/json',
      disposition: attachment(r.fileName),
    });
  }

  @Post('accounts/e-invoices/:kind/:id')
  @HttpCode(200)
  @RequiresFeatures()
  recordIrn(
    @Auth() c: TenantClaims,
    @Param('kind', new ZodPipe(kind)) k: 'invoice' | 'credit_note',
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          irn: z
            .string()
            .trim()
            .regex(/^[0-9a-fA-F]{64}$/, 'An IRN: 64 characters, 0-9 and a-f'),
          ackNo: z.string().trim().min(1).max(30),
          ackDate: z
            .string()
            .trim()
            .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/, 'A date and time'),
          signedQr: z.string().trim().min(10).max(8000),
        }),
      ),
    )
    b: { irn: string; ackNo: string; ackDate: string; signedQr: string },
  ) {
    return this.gst.recordIrn(c, k, id, {
      ...b,
      ackDate:
        b.ackDate.length === 10
          ? `${b.ackDate}T00:00:00+05:30`
          : `${b.ackDate.replace(' ', 'T')}+05:30`,
    });
  }

  @Get('accounts/gst/2b')
  reconcile(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), period })))
    q: { entityId: string; period: string },
  ) {
    return this.gst.reconcile(c, q);
  }

  /** multipart/form-data, field `file`: the GSTR-2B JSON downloaded from the portal. */
  @Post('accounts/gst/2b')
  @HttpCode(200)
  @RequiresFeatures()
  async upload2b(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), period })))
    q: { entityId: string; period: string },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    let raw: unknown;
    try {
      raw = JSON.parse((await file.toBuffer()).toString('utf8'));
    } catch {
      throw new BadRequestException({
        code: 'not_json',
        message: 'The 2B file is JSON, as the portal gives it.',
      });
    }
    return this.gst.upload2b(c, { ...q, fileName: file.filename, raw });
  }
}
