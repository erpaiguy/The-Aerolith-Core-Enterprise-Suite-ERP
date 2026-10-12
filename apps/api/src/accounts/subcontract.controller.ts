import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SubcontractService } from './subcontract.service.js';

const date = z.iso.date();
const decimal = (places: number, signed = false) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v).replace(/,/g, ''))
    .refine((v) => new RegExp(`^${signed ? '-?' : ''}\\d{1,16}(\\.\\d{1,${places}})?$`).test(v), {
      message: `A number with up to ${places} decimals`,
    });
const percent = decimal(2).refine((v) => Number(v) <= 100, { message: 'At most 100%' });
const terms = z.object({
  retentionPct: percent.default('0'),
  retentionCap: decimal(2).nullable().default(null),
  advanceRecoveryPct: percent.default('0'),
  labourCessPct: decimal(2)
    .refine((v) => Number(v) <= 10, { message: 'At most 10%' })
    .default('1'),
  tdsSection: z.enum(['194C', '194J']).nullable().default('194C'),
});
const measure = z.object({
  lineKey: z.uuid(),
  measuredOn: date,
  qty: decimal(4).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
  description: z.string().trim().max(500).default(''),
});
const update = z.object({
  rowVersion: z.number().int().positive(),
  lines: z.array(z.object({ lineKey: z.uuid(), cumQty: decimal(4) })).max(2000),
  backcharges: z
    .array(
      z.object({
        description: z.string().trim().min(2).max(200),
        amount: decimal(2).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        accountId: z.uuid(),
      }),
    )
    .max(50),
});
const rowVersion = z.object({ rowVersion: z.number().int().positive() });

/** Subcontract bills (docs/wave3-plan.md step 5). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SubcontractController {
  constructor(private readonly subcontracts: SubcontractService) {}

  @Get('projects/:id/subcontract-bills')
  projectBills(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.subcontracts.projectBills(c, id);
  }

  @Get('work-orders/:id/subcontract')
  workOrder(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.subcontracts.workOrder(c, id);
  }

  @Put('work-orders/:id/subcontract-terms')
  @RequiresFeatures()
  setTerms(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(terms)) b: z.infer<typeof terms>,
  ) {
    return this.subcontracts.setTerms(c, id, b);
  }

  @Post('work-orders/:id/measurements')
  @HttpCode(200)
  @RequiresFeatures()
  measure(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(measure)) b: z.infer<typeof measure>,
  ) {
    return this.subcontracts.measure(c, id, b);
  }

  @Post('wo-measurements/:id/reverse')
  @HttpCode(200)
  @RequiresFeatures()
  reverse(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ date, reason: z.string().trim().min(3).max(400) })))
    b: { date: string; reason: string },
  ) {
    return this.subcontracts.reverseMeasurement(c, id, b);
  }

  @Post('work-orders/:id/subcontract-bills')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ upto: date }))) b: { upto: string },
  ) {
    return this.subcontracts.create(c, id, b);
  }

  @Post('work-orders/:id/retention-release')
  @HttpCode(200)
  @RequiresFeatures()
  release(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          date,
          amount: decimal(2).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        }),
      ),
    )
    b: { date: string; amount: string },
  ) {
    return this.subcontracts.release(c, id, b);
  }

  @Get('subcontract-bills/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.subcontracts.get(c, id);
  }

  @Put('subcontract-bills/:id')
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    return this.subcontracts.update(c, id, b);
  }

  @Post('subcontract-bills/:id/refresh')
  @HttpCode(200)
  @RequiresFeatures()
  refresh(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rowVersion.extend({ upto: date }))) b: { upto: string; rowVersion: number },
  ) {
    return this.subcontracts.refresh(c, id, b);
  }

  @Post('subcontract-bills/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rowVersion)) b: { rowVersion: number },
  ) {
    return this.subcontracts.submit(c, id, b.rowVersion);
  }

  @Post('subcontract-bills/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(2000) })))
    b: { reason: string },
  ) {
    return this.subcontracts.cancel(c, id, b.reason);
  }
}
