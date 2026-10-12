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
import { EarnedValueService } from './earned-value.service.js';
import { METHODS } from './ev-rules.js';

const view = z.object({ asOf: z.iso.date().optional() });
const method = z.object({ method: z.enum(METHODS as [string, ...string[]]) });

/** Earned value (docs/wave4-plan.md step 3). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class EarnedValueController {
  constructor(private readonly ev: EarnedValueService) {}

  @Get('projects/:id/earned-value')
  report(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(view)) q: z.infer<typeof view>,
  ) {
    return this.ev.report(c, id, q.asOf ? { asOf: q.asOf } : {});
  }

  @Post('projects/:id/earned-value/method')
  @HttpCode(200)
  @RequiresFeatures()
  choose(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(method)) b: z.infer<typeof method>,
  ) {
    return this.ev.choose(c, id, b.method as (typeof METHODS)[number]);
  }
}
