import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { voucherBody } from './ledger.controller.js';
import { bill } from './payable.controller.js';
import { type RecurringInput, RecurringService } from './recurring.service.js';

const recurring = z.object({
  entityId: z.uuid(),
  kind: z.enum(['voucher', 'bill']),
  name: z.string().trim().min(2).max(200),
  frequency: z.enum(['monthly', 'quarterly', 'yearly']).default('monthly'),
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable().default(null),
  voucher: voucherBody.omit({ entityId: true, date: true }).nullable().default(null),
  bill: bill
    .pick({ partyId: true, projectId: true, tdsSection: true, narration: true, lines: true })
    .extend({ dueDays: z.number().int().min(0).max(365).default(30) })
    .nullable()
    .default(null),
});

/** Recurring vouchers and supplier bills (docs/wave7-plan.md step 7d.7). */
@Controller('tenant/accounts')
@UseGuards(TenantAuthGuard)
export class RecurringController {
  constructor(private readonly recurring: RecurringService) {}

  @Get('recurring')
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.recurring.list(c, q.entityId);
  }

  @Post('recurring')
  @HttpCode(200)
  @RequiresFeatures()
  create(@Auth() c: TenantClaims, @Body(new ZodPipe(recurring)) b: RecurringInput) {
    return this.recurring.create(c, b);
  }

  @Post('recurring/:id/active')
  @HttpCode(200)
  @RequiresFeatures()
  setActive(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ active: z.boolean() }))) b: { active: boolean },
  ) {
    return this.recurring.setActive(c, id, b.active);
  }

  @Post('recurring-drafts/:id/post')
  @HttpCode(200)
  @RequiresFeatures()
  post(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(z.object({ billNo: z.string().trim().min(1).max(60).nullable().default(null) })),
    )
    b: { billNo: string | null },
  ) {
    return this.recurring.post(c, id, b);
  }

  @Post('recurring-drafts/:id/skip')
  @HttpCode(200)
  @RequiresFeatures()
  skip(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ note: z.string().trim().max(500).default('') })))
    b: { note: string },
  ) {
    return this.recurring.skip(c, id, b.note);
  }
}
