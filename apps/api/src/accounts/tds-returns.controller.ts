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
import { TdsReturnService } from './tds-returns.service.js';

const date = z.iso.date();
const quarter = z.string().regex(/^\d{4}-\d{2}-Q[1-4]$/, 'A quarter: 2026-27-Q2');
const money = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v).replace(/,/g, ''))
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), { message: 'An amount' });
const section = z.enum(['194C', '194J', '194I', '194Q']);
const challan = z.object({
  entityId: z.uuid(),
  section,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month: YYYY-MM'),
  depositedOn: date,
  bsrCode: z
    .string()
    .trim()
    .regex(/^\d{7}$/, 'A BSR code: 7 digits'),
  challanNo: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'A challan serial number: 5 digits'),
  interest: money.default('0'),
  fee: money.default('0'),
  bankAccountId: z.uuid(),
  billIds: z.array(z.uuid()).max(5000).nullable().default(null),
});

/** Reads a 26AS or AIS extract: a header row naming TAN and TDS (and the deductor and amount), then a row a deduction. */
export async function creditRows(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({
      code: 'not_xlsx',
      message: 'Upload the extract as an Excel workbook.',
    });
  }
  const ws = wb.worksheets[0];
  const text = (v: ExcelJS.CellValue) =>
    v === null || v === undefined
      ? ''
      : typeof v === 'object' && 'result' in v
        ? String(v.result)
        : String(v);
  const rows: { tan: string; deductor: string; amount: string; tds: string }[] = [];
  let cols: { tan: number; deductor: number; amount: number; tds: number } | null = null;
  ws?.eachRow((row) => {
    const cells = Array.from(row.values as ExcelJS.CellValue[], text);
    if (!cols) {
      const find = (re: RegExp) => cells.findIndex((c) => re.test(c.trim()));
      const tan = find(/^TAN/i);
      const tds = find(/^(TDS|Tax deducted)/i);
      if (tan > 0 && tds > 0)
        cols = {
          tan,
          tds,
          deductor: cells.findIndex((c, i) => i !== tan && /(name|deductor)/i.test(c)),
          amount: find(/^amount/i),
        };
      return;
    }
    const tan = cells[cols.tan]?.trim().toUpperCase() ?? '';
    if (!/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) return;
    const num = (i: number) => (i > 0 ? (cells[i] ?? '').replace(/,/g, '').trim() || '0' : '0');
    rows.push({
      tan,
      deductor: cols.deductor > 0 ? (cells[cols.deductor] ?? '').trim() : '',
      amount: Number(num(cols.amount)).toFixed(2),
      tds: Number(num(cols.tds)).toFixed(2),
    });
  });
  if (!cols)
    throw new BadRequestException({
      code: 'no_header',
      message: 'Head the columns TAN and TDS (and the deductor and amount).',
    });
  return rows;
}

/** TDS deposited and returned (docs/wave3-plan.md step 6b). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class TdsReturnController {
  constructor(private readonly tds: TdsReturnService) {}

  @Get('accounts/tds/deductions')
  deductions(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ entityId: z.uuid(), from: date, to: date, section: section.optional() }),
      ),
    )
    q: { entityId: string; from: string; to: string; section?: string },
  ) {
    return this.tds.deductions(c, q);
  }

  @Get('accounts/tds/challans')
  challans(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
  ) {
    return this.tds.challans(c, q);
  }

  @Post('accounts/tds/challans')
  @HttpCode(200)
  @RequiresFeatures()
  createChallan(@Auth() c: TenantClaims, @Body(new ZodPipe(challan)) b: z.infer<typeof challan>) {
    return this.tds.createChallan(c, b);
  }

  @Get('accounts/tds/challans/:id')
  challan(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.tds.challan(c, id);
  }

  @Get('accounts/tds/26q')
  async form26q(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ entityId: z.uuid(), quarter, format: z.enum(['json', 'xlsx']).default('json') }),
      ),
    )
    q: { entityId: string; quarter: string; format: 'json' | 'xlsx' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.tds.form26q(c, q);
    if (q.format === 'json') return r;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aerolith Core';
    const d = wb.addWorksheet('Deductor');
    for (const [k, v] of [
      ['Quarter', q.quarter],
      ['TAN', r.deductor.tan ?? ''],
      ['PAN', r.deductor.pan ?? ''],
      ['Name', r.deductor.legalName || r.deductor.name],
      ['Address', r.deductor.address],
      ['City', r.deductor.city],
      ['PIN', r.deductor.pincode ?? ''],
    ])
      d.addRow([k, v]);
    d.getColumn(1).width = 12;
    d.getColumn(2).width = 50;
    const sheet = (name: string, headers: string[], rows: (string | number)[][]) => {
      const ws = wb.addWorksheet(name);
      ws.addRow(headers).font = { bold: true };
      headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(12, h.length + 2)));
      for (const row of rows) ws.addRow(row);
    };
    sheet(
      'Challans',
      [
        'Section',
        'BSR code',
        'Date deposited',
        'Challan serial no.',
        'TDS',
        'Interest',
        'Fee',
        'Total',
      ],
      (r.challans as unknown as Record<string, string>[]).map((x) => [
        x.section!,
        x.bsrCode!,
        x.depositedOn!,
        x.challanNo!,
        Number(x.tax),
        Number(x.interest),
        Number(x.fee),
        Number(x.total),
      ]),
    );
    sheet(
      'Deductees',
      [
        'Deductee PAN',
        'Deductee name',
        'Section',
        'Date of payment or credit',
        'Amount paid or credited',
        'TDS base',
        'Rate %',
        'TDS',
        'BSR code',
        'Date deposited',
        'Challan serial no.',
        'Remark',
      ],
      r.deductees.map((x) => [
        x.pan ?? 'PANNOTAVBL',
        x.party,
        x.section,
        x.date,
        Number(x.paid),
        Number(x.base),
        Number(x.rate),
        Number(x.tds),
        x.challan?.bsrCode ?? '',
        x.challan?.depositedOn ?? '',
        x.challan?.challanNo ?? '',
        x.pan ? '' : 'C',
      ]),
    );
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(`26Q-${q.quarter}.xlsx`),
    });
  }

  @Get('accounts/tds/credits')
  credits(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), quarter })))
    q: { entityId: string; quarter: string },
  ) {
    return this.tds.matchCredits(c, q);
  }

  /** multipart/form-data, field `file`: the 26AS or AIS extract as Excel (TAN, deductor, amount, TDS). */
  @Post('accounts/tds/credits')
  @HttpCode(200)
  @RequiresFeatures()
  async uploadCredits(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), quarter })))
    q: { entityId: string; quarter: string },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the workbook as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No workbook was sent.' });
    const rows = await creditRows(await file.toBuffer());
    return this.tds.uploadCredits(c, { ...q, fileName: file.filename, rows });
  }
}
