import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ClientBillService } from './client-bill.service.js';

const date = z.iso.date();
const decimal = (places: number, digits = 14) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^-?\\d{1,${digits}}(\\.\\d{1,${places}})?$`).test(v), {
      message: `A number with up to ${places} decimals`,
    });
const pct = decimal(2, 3).refine((v) => Number(v) >= 0 && Number(v) <= 100, {
  message: '0 to 100',
});
const positive = (places: number) =>
  decimal(places).refine((v) => Number(v) >= 0, { message: 'Not below nothing' });
/** Price escalation terms (docs/wave8-plan.md step 8d.1), shared with subcontract work orders. */
export const escalationTerms = z
  .object({
    factor: decimal(4, 2).refine((v) => Number(v) > 0 && Number(v) <= 1, {
      message: 'Above 0, at most 1',
    }),
    components: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
          name: z.string().trim().min(2).max(60),
          sharePct: pct,
          baseIndex: decimal(4, 8).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
          // docs/wave8-plan.md step 8d.1: the index series whose period average stands as the index.
          seriesKey: z
            .string()
            .regex(/^[a-z0-9_]{2,40}$/)
            .nullable()
            .default(null),
        }),
      )
      .min(1)
      .max(10),
    excludeLineKeys: z.array(z.uuid()).max(500).default([]),
    items: z
      .array(
        z.object({
          lineKey: z.uuid(),
          key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
          name: z.string().trim().min(2).max(60),
          baseIndex: decimal(4, 8).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
          seriesKey: z
            .string()
            .regex(/^[a-z0-9_]{2,40}$/)
            .nullable()
            .default(null),
        }),
      )
      .max(50)
      .default([]),
  })
  .nullable()
  .default(null);
const terms = z.object({
  rowVersion: z.number().int().positive().nullable(),
  gstPct: pct.refine((v) => Number(v) <= 28, { message: 'At most 28%' }),
  retentionPct: pct,
  retentionCap: positive(2).nullable().default(null),
  advanceAmount: positive(2).default('0'),
  advanceRecoveryPct: pct.default('0'),
  sac: z
    .string()
    .trim()
    .regex(/^[0-9]{4,8}$/, 'A SAC or HSN code: 4 to 8 digits')
    .default('9954'),
  escalation: escalationTerms,
});
const create = z.object({ upto: date, siteId: z.uuid().nullable().default(null) });
const update = z.object({
  rowVersion: z.number().int().positive(),
  indices: z.record(z.string(), decimal(4, 8)).default({}),
  lines: z
    .array(z.object({ lineKey: z.uuid(), cumQty: decimal(4) }))
    .max(20000)
    .default([]),
  deductions: z
    .array(
      z.object({
        description: z.string().trim().min(2).max(200),
        amount: decimal(2).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        accountId: z.uuid(),
      }),
    )
    .max(50)
    .default([]),
});
const certify = z.object({
  rowVersion: z.number().int().positive(),
  certifiedOn: date,
  clientRef: z.string().trim().max(100).default(''),
  lines: z
    .array(z.object({ lineKey: z.uuid(), certQty: decimal(4) }))
    .max(20000)
    .default([]),
});

/** Client RA bills (docs/wave3-plan.md step 2). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ClientBillController {
  constructor(private readonly bills: ClientBillService) {}

  @Get('projects/:id/client-bills')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.projectBills(c, id);
  }

  @Post('projects/:id/bill-terms')
  @HttpCode(200)
  @RequiresFeatures()
  setTerms(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(terms)) b: z.infer<typeof terms>,
  ) {
    return this.bills.setTerms(c, id, b);
  }

  @Post('projects/:id/client-bills')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    return this.bills.create(c, id, b);
  }

  @Get('client-bills/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.get(c, id);
  }

  @Post('client-bills/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    return this.bills.update(c, id, b);
  }

  @Post('client-bills/:id/refresh')
  @HttpCode(200)
  @RequiresFeatures()
  refresh(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ upto: date }))) b: { upto: string },
  ) {
    return this.bills.refresh(c, id, b);
  }

  @Post('client-bills/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ rowVersion: z.number().int().positive() })))
    b: { rowVersion: number },
  ) {
    return this.bills.submit(c, id, b.rowVersion);
  }

  @Post('client-bills/:id/certify')
  @HttpCode(200)
  @RequiresFeatures()
  certify(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(certify)) b: z.infer<typeof certify>,
  ) {
    return this.bills.certify(c, id, b);
  }

  @Post('client-bills/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(2000) })))
    b: { reason: string },
  ) {
    return this.bills.cancel(c, id, b.reason);
  }

  /** The bill as Excel: the abstract, then each item with previous, this and cumulative quantities. */
  @Get('client-bills/:id/xlsx')
  async xlsx(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = await this.bills.get(c, id);
    const certified = b.status === 'certified';
    const f = (b.certified ?? b.submitted ?? b.figures) as unknown as Record<string, string> | null;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aerolith Core';
    const head = (ws: ExcelJS.Worksheet, title: string) => {
      ws.addRow([title]).font = { bold: true, size: 13 };
      ws.addRow([`${b.project.number} · ${b.project.name}`]);
      ws.addRow([`${b.company.legalName || b.company.name}, GSTIN ${b.company.gstin ?? '-'}`]);
      ws.addRow([
        `To ${b.client?.name ?? '-'}${b.client?.gstin ? `, GSTIN ${b.client.gstin}` : ''}`,
      ]);
      ws.addRow([
        `Measured up to ${b.upto}${b.invoiceNo ? `; tax invoice ${b.invoiceNo} of ${b.invoiceDate}` : ''}${b.clientRef ? `; certificate ${b.clientRef}` : ''}`,
      ]);
      ws.addRow([]);
    };
    const abstract = wb.addWorksheet('Abstract');
    head(abstract, `RA bill ${b.raNo}${certified ? ' (certified)' : ''}`);
    abstract.getColumn(1).width = 44;
    abstract.getColumn(2).width = 18;
    abstract.getColumn(2).numFmt = '#,##0.00';
    if (f) {
      const row = (label: string, v: string | undefined, bold = false) => {
        if (v === undefined || (Number(v) === 0 && !bold)) return;
        const r = abstract.addRow([label, Number(v)]);
        if (bold) r.font = { bold: true };
      };
      row('Value of work done this bill', f.gross, true);
      row('Price variation (escalation)', f.escalationTotal);
      row('Taxable value', f.taxable, true);
      row('CGST', f.cgst);
      row('SGST', f.sgst);
      row('IGST', f.igst);
      row('Invoice total', f.invoiceTotal, true);
      row('Less: retention', f.retention);
      row('Less: mobilisation advance recovered', f.advanceRecovery);
      for (const d of b.deductions) row(`Less: ${d.description}`, d.amount);
      row('Net payable', f.net, true);
    }
    const items = wb.addWorksheet('Bill');
    head(items, `RA bill ${b.raNo}: items`);
    const cols = [
      'Code',
      'Description',
      'Unit',
      'Rate',
      'Previous',
      'This bill',
      'Cumulative',
      'Amount this bill',
    ];
    items.addRow(cols).font = { bold: true };
    [10, 50, 8, 12, 12, 12, 12, 16].forEach((w, i) => (items.getColumn(i + 1).width = w));
    for (const l of b.lines) {
      const cum = Number(certified ? (l.certQty ?? l.cumQty) : l.cumQty);
      const prev = Number(l.prevQty);
      items.addRow([
        l.code,
        l.description,
        l.unit,
        Number(l.rate),
        prev,
        cum - prev,
        cum,
        Math.round((cum - prev) * Number(l.rate) * 100) / 100,
      ]);
    }
    items.getColumn(8).numFmt = '#,##0.00';
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(`${b.project.number} RA ${b.raNo}.xlsx`),
    });
  }
}
