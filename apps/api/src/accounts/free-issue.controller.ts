import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DebitProposalService } from './debit-proposal.service.js';
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

/** Debit notes proposed from the stores and the order (docs/wave8-plan.md step 8a.5). */
@Controller('tenant/accounts/debit-note-proposals')
@UseGuards(TenantAuthGuard)
export class DebitProposalController {
  constructor(private readonly proposals: DebitProposalService) {}

  @Get()
  list(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid() }))) q: { entityId: string },
  ) {
    return this.proposals.proposals(c, q.entityId);
  }

  @Post()
  @HttpCode(200)
  @RequiresFeatures()
  accept(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          entityId: z.uuid(),
          key: z.string().regex(/^(short|rate):[0-9a-f-]{36}:[0-9a-f-]{36}$/),
          date: z.iso.date().optional(),
        }),
      ),
    )
    b: { entityId: string; key: string; date?: string },
  ) {
    return this.proposals.accept(c, b.entityId, b.key, b.date);
  }
}
