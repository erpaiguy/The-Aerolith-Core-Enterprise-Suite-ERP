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
import { MaterialBudgetService } from './material-budget.service.js';

const decimal = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), { message: 'A number with up to 4 decimals' });
const update = z.object({
  rowVersion: z.number().int().positive(),
  reason: z.string().trim().max(2000).default(''),
  lines: z
    .array(
      z.object({
        resourceId: z.uuid(),
        qty: decimal,
        rate: decimal.nullable().default(null),
        note: z.string().trim().max(500).default(''),
      }),
    )
    .max(20_000),
});
const submit = z.object({ rowVersion: z.number().int().positive() });
const revise = z.object({ reason: z.string().trim().min(3).max(2000) });
const forItem = z.object({
  code: z.string().trim().min(1).max(40),
  qty: decimal.refine((v) => Number(v) > 0, { message: 'More than nothing' }),
});
const lookahead = z.object({ weeks: z.coerce.number().int().min(1).max(12).default(2) });

/** A project's material budget and what its work needs (docs/wave2b-plan.md step 2). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class MaterialBudgetController {
  constructor(private readonly budgets: MaterialBudgetService) {}

  @Get('projects/:id/material-budget')
  overview(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.overview(c, id);
  }

  @Post('projects/:id/material-budget/from-tender')
  @HttpCode(200)
  @RequiresFeatures()
  fromTender(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.fromTender(c, id);
  }

  @Post('projects/:id/material-budget/blank')
  @HttpCode(200)
  @RequiresFeatures()
  blank(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.blank(c, id);
  }

  @Post('projects/:id/material-budget/revise')
  @HttpCode(200)
  @RequiresFeatures()
  revise(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(revise)) b: z.infer<typeof revise>,
  ) {
    return this.budgets.revise(c, id, b.reason);
  }

  @Get('projects/:id/material-demand/item')
  forItem(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(forItem)) q: z.infer<typeof forItem>,
  ) {
    return this.budgets.forItem(c, id, q.code, q.qty);
  }

  @Get('projects/:id/material-demand/lookahead')
  lookahead(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(lookahead)) q: z.infer<typeof lookahead>,
  ) {
    return this.budgets.lookahead(c, id, q.weeks);
  }

  @Get('material-budgets/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.get(c, id);
  }

  @Post('material-budgets/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    return this.budgets.update(c, id, b.rowVersion, { reason: b.reason, lines: b.lines });
  }

  @Post('material-budgets/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submit)) b: z.infer<typeof submit>,
  ) {
    return this.budgets.submit(c, id, b.rowVersion);
  }

  @Post('material-budgets/:id/discard')
  @HttpCode(200)
  @RequiresFeatures()
  discard(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.discard(c, id);
  }
}
