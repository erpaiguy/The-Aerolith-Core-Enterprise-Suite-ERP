import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { moneyCol, reportXlsx } from '../procurement/procurement-report-excel.js';
import { PayableService } from './payable.service.js';

const date = z.iso.date();
const decimal = (places: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v).replace(/,/g, ''))
    .refine((v) => new RegExp(`^\\d{1,16}(\\.\\d{1,${places}})?$`).test(v), {
      message: `A number with up to ${places} decimals`,
    });
const positive = (places: number) =>
  decimal(places).refine((v) => Number(v) > 0, { message: 'More than nothing' });
const bill = z.object({
  entityId: z.uuid(),
  partyId: z.uuid(),
  orderId: z.uuid().nullable().default(null),
  projectId: z.uuid().nullable().default(null),
  billNo: z.string().trim().min(1).max(60),
  billDate: date,
  dueDate: date,
  tdsSection: z.enum(['194C', '194J', '194I', '194Q']).nullable().default(null),
  narration: z.string().trim().max(2000).default(''),
  lines: z
    .array(
      z.object({
        lineKey: z.uuid().nullable().default(null),
        accountId: z.uuid().nullable().default(null),
        projectId: z.uuid().nullable().default(null),
        description: z.string().trim().max(1000).default(''),
        unit: z.string().trim().max(20).nullable().default(null),
        qty: positive(4),
        rate: decimal(4),
        gstPct: decimal(2)
          .refine((v) => Number(v) <= 28, { message: 'At most 28%' })
          .default('18'),
      }),
    )
    .min(1)
    .max(500),
});
const reason = z.object({ reason: z.string().trim().min(3).max(500) });
const run = z.object({
  entityId: z.uuid(),
  bankAccountId: z.uuid(),
  payOn: date,
  lines: z
    .array(
      z.object({
        partyId: z.uuid(),
        kind: z.enum(['bill', 'advance']),
        billId: z.uuid().nullable().default(null),
        projectId: z.uuid().nullable().default(null),
        amount: positive(2),
      }),
    )
    .min(1)
    .max(500),
});

/** Payables (docs/wave3-plan.md step 4). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class PayableController {
  constructor(private readonly payables: PayableService) {}

  @Get('accounts/tds-sections')
  sections(@Auth() c: TenantClaims) {
    return this.payables.sections(c);
  }

  @Get('accounts/payables-settings')
  settings(@Auth() c: TenantClaims) {
    return this.payables.settings(c);
  }

  @Post('accounts/payables-settings')
  @HttpCode(200)
  setTolerance(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ rateTolerancePct: decimal(2) }))) b: { rateTolerancePct: string },
  ) {
    return this.payables.setTolerance(c, b.rateTolerancePct);
  }

  @Get('accounts/vendor-bills')
  bills(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          partyId: z.uuid().optional(),
          status: z.enum(['held', 'posted', 'cancelled']).optional(),
        }),
      ),
    )
    q: { entityId: string; partyId?: string; status?: string },
  ) {
    return this.payables.bills(c, q);
  }

  @Post('accounts/vendor-bills')
  @HttpCode(200)
  @RequiresFeatures()
  createBill(@Auth() c: TenantClaims, @Body(new ZodPipe(bill)) b: z.infer<typeof bill>) {
    return this.payables.createBill(c, b);
  }

  @Get('accounts/vendor-bills/:id')
  bill(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payables.bill(c, id);
  }

  @Post('accounts/vendor-bills/:id/pass')
  @HttpCode(200)
  @RequiresFeatures()
  pass(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: { reason: string },
  ) {
    return this.payables.passBill(c, id, b.reason);
  }

  @Post('accounts/vendor-bills/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason.extend({ date }))) b: { reason: string; date: string },
  ) {
    return this.payables.cancelBill(c, id, b);
  }

  @Post('accounts/vendor-bills/:id/debit-notes')
  @HttpCode(200)
  @RequiresFeatures()
  debitNote(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(reason.extend({ date, taxable: positive(2), gstPct: decimal(2).default('18') })),
    )
    b: { reason: string; date: string; taxable: string; gstPct: string },
  ) {
    return this.payables.debitNote(c, id, b);
  }

  @Post('accounts/vendor-bills/:id/apply-advance')
  @HttpCode(200)
  @RequiresFeatures()
  applyAdvance(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date, amount: positive(2) }))) b: { date: string; amount: string },
  ) {
    return this.payables.applyAdvance(c, id, b);
  }

  @Get('accounts/payment-runs')
  runs(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.payables.runs(c, q.entityId);
  }

  @Post('accounts/payment-runs')
  @HttpCode(200)
  @RequiresFeatures()
  createRun(@Auth() c: TenantClaims, @Body(new ZodPipe(run)) b: z.infer<typeof run>) {
    return this.payables.createRun(c, b);
  }

  @Get('accounts/payment-runs/:id')
  run(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payables.run(c, id);
  }

  @Post('accounts/payment-runs/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submitRun(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.payables.submitRun(c, id);
  }

  @Post('accounts/payment-runs/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancelRun(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: { reason: string },
  ) {
    return this.payables.cancelRun(c, id, b.reason);
  }

  @Post('accounts/payment-runs/:id/paid')
  @HttpCode(200)
  @RequiresFeatures()
  paid(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ paidOn: date }))) b: { paidOn: string },
  ) {
    return this.payables.markPaid(c, id, b.paidOn);
  }

  @Get('accounts/payment-runs/:id/bank-file')
  async bankFile(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.payables.bankFile(c, id);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(f.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: attachment(f.fileName),
    });
  }

  @Get('accounts/payables')
  async payablesReport(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          asOf: date,
          format: z.enum(['json', 'xlsx']).default('json'),
        }),
      ),
    )
    q: { entityId: string; asOf: string; format: 'json' | 'xlsx' },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.payables.payables(c, q);
    if (q.format === 'json') return r;
    type L = (typeof r.bills)[number];
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await reportXlsx<L>(
        'Payables',
        [`Payables as at ${q.asOf}`],
        [
          { header: 'Supplier', value: (l) => l.party.name, width: 28 },
          { header: 'Bill', value: (l) => l.billNo, width: 16 },
          { header: 'Bill date', value: (l) => l.billDate, width: 12 },
          { header: 'Due', value: (l) => l.dueDate, width: 12 },
          moneyCol<L>('Payable', (l) => l.payable),
          moneyCol<L>('Outstanding', (l) => l.outstanding),
          { header: 'Days overdue', value: (l) => l.overdueDays, width: 10 },
          { header: 'Age', value: (l) => l.bucket, width: 10 },
        ],
        r.bills,
      ),
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        disposition: attachment('Payables.xlsx'),
      },
    );
  }
}
