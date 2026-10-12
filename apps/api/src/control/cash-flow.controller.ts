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
import { CashFlowService } from './cash-flow.service.js';

const view = z.object({
  asOf: z.iso.date().optional(),
  by: z.enum(['month', 'week']).default('month'),
});
const days = z.number().int().min(0).max(365);
const terms = z.object({
  certifyDays: days,
  clientPayDays: days,
  clientTdsPct: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'A percentage'),
  supplierDays: days,
  costDays: days,
  rowVersion: z.number().int().positive().nullable(),
});
const overheads = z.object({
  amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'An amount in rupees'),
});

/** Cash flow (docs/wave4-plan.md step 2). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class CashFlowController {
  constructor(private readonly cash: CashFlowService) {}

  @Get('projects/:id/cash-flow')
  project(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(view)) q: z.infer<typeof view>,
  ) {
    return this.cash.project(c, id, { by: q.by, ...(q.asOf ? { asOf: q.asOf } : {}) });
  }

  @Post('projects/:id/cash-terms')
  @HttpCode(200)
  @RequiresFeatures()
  terms(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(terms)) b: z.infer<typeof terms>,
  ) {
    return this.cash.setTerms(c, id, b);
  }

  @Get('accounts/cash-flow')
  company(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(view.extend({ entityId: z.uuid() })))
    q: z.infer<typeof view> & { entityId: string },
  ) {
    return this.cash.company(c, {
      entityId: q.entityId,
      by: q.by,
      ...(q.asOf ? { asOf: q.asOf } : {}),
    });
  }

  @Post('accounts/cash-flow/:entityId/overheads')
  @HttpCode(200)
  @RequiresFeatures()
  overheads(
    @Auth() c: TenantClaims,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Body(new ZodPipe(overheads)) b: z.infer<typeof overheads>,
  ) {
    return this.cash.setOverheads(c, entityId, b.amount);
  }
}
