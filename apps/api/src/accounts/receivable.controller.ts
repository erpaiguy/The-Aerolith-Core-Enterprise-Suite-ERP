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
import { ReceivableService } from './receivable.service.js';

const date = z.iso.date();
const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), { message: 'An amount with up to 2 decimals' });
const receipt = z.object({
  entityId: z.uuid(),
  partyId: z.uuid(),
  receivedOn: date,
  bankAccountId: z.uuid(),
  amount: amount.refine((v) => Number(v) > 0, { message: 'More than nothing' }),
  tds: amount.default('0'),
  reference: z.string().trim().max(100).default(''),
  narration: z.string().trim().max(2000).default(''),
  allocations: z
    .array(
      z.object({
        kind: z.enum(['bill', 'retention', 'advance']),
        billId: z.uuid().nullable().default(null),
        projectId: z.uuid().nullable().default(null),
        amount: amount.refine((v) => Number(v) > 0, { message: 'More than nothing' }),
      }),
    )
    .min(1)
    .max(200),
  deductions: z
    .array(
      z.object({
        description: z.string().trim().min(2).max(200),
        amount: amount.refine((v) => Number(v) > 0),
        accountId: z.uuid(),
      }),
    )
    .max(20)
    .default([]),
});

/** Receivables (docs/wave3-plan.md step 3). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ReceivableController {
  constructor(private readonly receivables: ReceivableService) {}

  @Get('accounts/open-items')
  openItems(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), partyId: z.uuid() })))
    q: { entityId: string; partyId: string },
  ) {
    return this.receivables.openItems(c, q.entityId, q.partyId);
  }

  @Get('accounts/client-receipts')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), partyId: z.uuid().optional() })))
    q: { entityId: string; partyId?: string },
  ) {
    return this.receivables.list(c, q);
  }

  @Post('accounts/client-receipts')
  @HttpCode(200)
  @RequiresFeatures()
  record(@Auth() c: TenantClaims, @Body(new ZodPipe(receipt)) b: z.infer<typeof receipt>) {
    return this.receivables.record(c, b);
  }

  @Get('accounts/client-receipts/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.receivables.get(c, id);
  }

  @Post('accounts/client-receipts/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date, reason: z.string().trim().min(3).max(500) })))
    b: { date: string; reason: string },
  ) {
    return this.receivables.cancel(c, id, b);
  }

  @Get('accounts/receivables')
  async receivablesReport(
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
    const r = await this.receivables.receivables(c, q);
    if (q.format === 'json') return r;
    type L = (typeof r.bills)[number];
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await reportXlsx<L>(
        'Receivables',
        [`Receivables as at ${q.asOf}`],
        [
          { header: 'Client', value: (l) => l.party.name, width: 28 },
          { header: 'Project', value: (l) => `${l.project.number} ${l.project.name}`, width: 30 },
          { header: 'Bill', value: (l) => `RA ${l.raNo}`, width: 8 },
          { header: 'Invoice', value: (l) => l.invoiceNo, width: 20 },
          { header: 'Invoice date', value: (l) => l.invoiceDate, width: 12 },
          moneyCol<L>('Net payable', (l) => l.net),
          moneyCol<L>('Received', (l) => l.received),
          moneyCol<L>('Outstanding', (l) => l.outstanding),
          { header: 'Days', value: (l) => l.ageDays, width: 8 },
          { header: 'Age', value: (l) => l.bucket, width: 10 },
        ],
        r.bills,
      ),
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        disposition: attachment('Receivables.xlsx'),
      },
    );
  }
}
