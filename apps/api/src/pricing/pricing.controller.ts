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
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MARKUP_KINDS, type MarkupKind } from './pricing.js';
import { PricingService } from './pricing.service.js';

const number = (places: number, digits: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^\\d{1,${digits}}(\\.\\d{1,${places}})?$`).test(v), {
      message: `A number with up to ${places} decimals`,
    });
const markup = z
  .object({
    kind: z.enum(MARKUP_KINDS as [MarkupKind, ...MarkupKind[]]),
    label: z.string().trim().min(1).max(100),
    basis: z.enum(['base', 'running']).default('base'),
    pct: number(4, 4)
      .refine((v) => Number(v) <= 1000, 'At most 1000 %')
      .nullable()
      .optional(),
    amount: number(2, 16).nullable().optional(),
  })
  .refine((m) => (m.pct != null) !== (m.amount != null), {
    message: 'Give either a percentage or an amount',
  });
const scenarioBody = z.object({
  name: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(4000).default(''),
  markups: z.array(markup).max(20).default([]),
  gstPct: number(2, 3)
    .refine((v) => Number(v) <= 100, 'At most 100 %')
    .default('18'),
  gstMode: z.enum(['add', 'included', 'exempt']).default('add'),
});
const scenarioUpdate = scenarioBody.extend({ rowVersion: z.number().int().positive() });
const copyBody = z.object({ name: z.string().trim().min(1).max(100) });

/**
 * Bid pricing (E5). Margins are sensitive: seeing and changing pricing both need `pricing.edit` (admins always;
 * managers by default; the admin decides for others).
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
@RequiresPermission('pricing.edit')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('boqs/:id/pricing')
  summary(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.summary(c, id);
  }

  @Post('boqs/:id/pricing/preview')
  @HttpCode(200)
  preview(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(scenarioBody)) b: z.infer<typeof scenarioBody>,
  ) {
    return this.pricing.preview(c, id, b);
  }

  @Post('boqs/:id/scenarios')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(scenarioBody)) b: z.infer<typeof scenarioBody>,
  ) {
    return this.pricing.create(c, id, b);
  }

  @Post('scenarios/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(scenarioUpdate)) b: z.infer<typeof scenarioUpdate>,
  ) {
    const { rowVersion, ...input } = b;
    return this.pricing.update(c, id, rowVersion, input);
  }

  @Post('scenarios/:id/select')
  @HttpCode(200)
  @RequiresFeatures()
  select(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.select(c, id);
  }

  @Post('scenarios/:id/copy')
  @HttpCode(200)
  @RequiresFeatures()
  copy(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(copyBody)) b: z.infer<typeof copyBody>,
  ) {
    return this.pricing.copy(c, id, b.name);
  }

  @Post('scenarios/:id/delete')
  @HttpCode(200)
  @RequiresFeatures()
  remove(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.remove(c, id);
  }

  @Get('tenders/:id/bid-summary')
  tender(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.tenderSummary(c, id);
  }
}
