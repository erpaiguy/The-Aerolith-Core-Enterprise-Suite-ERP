import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { FlowService, type PurchaseFlowKind } from './flows.service.js';

/** Where a purchase stands, from any of its documents (docs/wave9-plan.md step 9a.7). Read only. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class FlowController {
  constructor(private readonly flows: FlowService) {}

  @Get('flows/purchase/:kind/:id')
  purchase(
    @Auth() c: TenantClaims,
    @Param('kind', new ZodPipe(z.enum(['requisition', 'order', 'receipt', 'bill'])))
    k: PurchaseFlowKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.flows.purchase(c, k, id);
  }
}
