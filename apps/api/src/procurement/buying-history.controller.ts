import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { BuyingHistoryService } from './buying-history.service.js';

/** Buying with history (docs/wave8-plan.md step 8e.4). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class BuyingHistoryController {
  constructor(private readonly history: BuyingHistoryService) {}

  /** `?resourceIds=a,b,c`: up to 100 materials. */
  @Get('procurement/purchase-history')
  purchaseHistory(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          resourceIds: z
            .string()
            .transform((v) => [...new Set(v.split(',').filter(Boolean))])
            .pipe(z.array(z.uuid()).max(100)),
        }),
      ),
    )
    q: { resourceIds: string[] },
  ) {
    return this.history.history(c, q.resourceIds);
  }

  @Get('procurement/stock-ageing')
  ageing(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ storeId: z.uuid().optional() }))) q: { storeId?: string },
  ) {
    return this.history.ageing(c, q);
  }
}
