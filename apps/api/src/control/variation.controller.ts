import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { VariationService } from './variation.service.js';

const qty = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'A quantity');
const rate = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'A rate');
const line = z.object({
  kind: z.enum(['new', 'change']),
  code: z.string().trim().min(1).max(40),
  description: z.string().trim().max(2000).default(''),
  unit: z.string().trim().max(20).default(''),
  qty,
  rate: rate.nullable().default(null),
  costRate: rate.nullable().default(null),
  rateAnalysisId: z.uuid().nullable().default(null),
});
const body = z.object({
  title: z.string().trim().min(3).max(300),
  source: z.enum(['client_instruction', 'site_condition', 'design_change', 'other']),
  instructionRef: z.string().trim().max(200).default(''),
  reason: z.string().trim().max(4000).default(''),
  contractBoqId: z.uuid().nullable().default(null),
  days: z.number().int().min(0).max(3650).default(0),
  activities: z
    .array(z.object({ planId: z.uuid(), activityId: z.string().regex(/^\d+$/) }))
    .max(50)
    .default([]),
  lines: z.array(line).min(1).max(500),
});
const update = body.extend({ rowVersion: z.number().int().positive() });
const submit = z.object({ rowVersion: z.number().int().positive() });
const client = z.object({
  decision: z.enum(['approved', 'rejected']),
  reference: z.string().trim().min(1).max(200),
  date: z.iso.date(),
  lines: z
    .array(
      z.object({
        position: z.number().int().positive(),
        qty: qty.optional(),
        rate: rate.optional(),
      }),
    )
    .max(500)
    .default([]),
  rowVersion: z.number().int().positive(),
});

/** Variations and change orders (docs/wave4-plan.md step 4). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class VariationController {
  constructor(private readonly variations: VariationService) {}

  @Get('projects/:id/variations')
  register(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.variations.register(c, id);
  }

  @Post('projects/:id/variations')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(body)) b: z.infer<typeof body>,
  ) {
    return this.variations.create(c, id, b);
  }

  @Post('projects/:id/variations/settings')
  @HttpCode(200)
  @RequiresFeatures()
  settings(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ billPending: z.boolean() }))) b: { billPending: boolean },
  ) {
    return this.variations.setBillPending(c, id, b.billPending);
  }

  @Get('variations/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.variations.get(c, id);
  }

  @Post('variations/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    return this.variations.update(c, id, b);
  }

  @Post('variations/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submit)) b: z.infer<typeof submit>,
  ) {
    return this.variations.submit(c, id, b.rowVersion);
  }

  @Post('variations/:id/client')
  @HttpCode(200)
  @RequiresFeatures()
  client(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(client)) b: z.infer<typeof client>,
  ) {
    return this.variations.clientDecision(c, id, b);
  }

  @Post('variations/:id/started')
  @HttpCode(200)
  @RequiresFeatures()
  started(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ on: z.iso.date().nullable() }))) b: { on: string | null },
  ) {
    return this.variations.started(c, id, b.on);
  }

  @Post('variations/:id/withdraw')
  @HttpCode(200)
  @RequiresFeatures()
  withdraw(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.variations.withdraw(c, id);
  }
}
