import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CompanyDashboardService } from './company.service.js';

/** The company dashboard (docs/wave7-plan.md step 7d.9). */
@Controller('tenant/company-dashboard')
@UseGuards(TenantAuthGuard)
export class CompanyDashboardController {
  constructor(private readonly dashboard: CompanyDashboardService) {}

  @Get()
  get(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), asOf: z.iso.date().optional() })))
    q: { entityId: string; asOf?: string },
  ) {
    return this.dashboard.get(c, q.entityId, q.asOf);
  }
}
