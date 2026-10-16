import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ItcReversalService } from './itc-reversal.service.js';

const asOf = z.object({ entityId: z.uuid(), asOf: z.iso.date() });

/** Tax compliance (docs/wave8-plan.md Wave 8b). Who may do what is checked by the services. */
@Controller('tenant/accounts')
@UseGuards(TenantAuthGuard)
export class TaxComplianceController {
  constructor(private readonly rule37: ItcReversalService) {}

  @Get('itc-reversals')
  reversals(@Auth() c: TenantClaims, @Query(new ZodPipe(asOf)) q: z.infer<typeof asOf>) {
    return this.rule37.view(c, q.entityId, q.asOf);
  }

  @Post('itc-reversals')
  @HttpCode(200)
  @RequiresFeatures()
  runReversals(@Auth() c: TenantClaims, @Body(new ZodPipe(asOf)) b: z.infer<typeof asOf>) {
    return this.rule37.run(c, b.entityId, b.asOf);
  }
}
