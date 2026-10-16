import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { RevenueRecognitionService } from './revenue-recognition.service.js';

const monthQ = z.object({
  entityId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM'),
});

/** Revenue on work done (docs/wave8-plan.md step 8a.1). */
@Controller('tenant/accounts/revenue-recognition')
@UseGuards(TenantAuthGuard)
export class RevenueRecognitionController {
  constructor(private readonly revenue: RevenueRecognitionService) {}

  @Get()
  month(@Auth() c: TenantClaims, @Query(new ZodPipe(monthQ)) q: z.infer<typeof monthQ>) {
    return this.revenue.month(c, q.entityId, q.month);
  }

  @Post()
  @HttpCode(200)
  @RequiresFeatures()
  post(@Auth() c: TenantClaims, @Body(new ZodPipe(monthQ)) b: z.infer<typeof monthQ>) {
    return this.revenue.post(c, b.entityId, b.month);
  }
}
