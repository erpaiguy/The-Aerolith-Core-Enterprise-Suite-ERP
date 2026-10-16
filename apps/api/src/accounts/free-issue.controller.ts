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
import { FreeIssueService, type MaterialTerm } from './free-issue.service.js';

const decimal = (places: number) =>
  z
    .string()
    .trim()
    .regex(
      new RegExp(`^\\d{1,14}(\\.\\d{1,${places}})?$`),
      `A number with up to ${places} decimals`,
    );
const terms = z.object({
  items: z
    .array(
      z.object({
        lineKey: z.uuid(),
        resourceId: z.uuid(),
        perUnit: decimal(6),
        wastagePct: decimal(2)
          .refine((v) => Number(v) <= 100, { message: 'At most 100%' })
          .default('0'),
        penalRate: decimal(4),
      }),
    )
    .max(500),
});

/** Free-issue material to subcontractors (docs/wave8-plan.md step 8a.3). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class FreeIssueController {
  constructor(private readonly free: FreeIssueService) {}

  @Get('work-orders/:id/free-issue')
  forOrder(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.free.forOrder(c, id);
  }

  @Put('work-orders/:id/free-issue')
  @RequiresFeatures()
  setTerms(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(terms)) b: { items: MaterialTerm[] },
  ) {
    return this.free.setTerms(c, id, b.items);
  }

  @Get('subcontract-bills/:id/free-issue')
  forBill(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.free.forBill(c, id);
  }

  @Post('subcontract-bills/:id/free-issue/recover')
  @HttpCode(200)
  @RequiresFeatures()
  recover(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.free.recover(c, id);
  }
}
