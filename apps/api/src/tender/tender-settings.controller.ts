import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, Roles, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TenderSettingsService } from './tender-settings.service.js';

const criteriaBody = z.object({
  criteria: z
    .array(
      z.object({
        key: z
          .string()
          .regex(/^[a-z0-9_]{1,40}$/)
          .optional(),
        label: z.string().trim().min(3).max(120),
        weight: z.number().int().min(0).max(5),
      }),
    )
    .min(1)
    .max(20)
    .nullable(),
});
const checklistBody = z.object({
  items: z
    .array(
      z.object({
        envelope: z.enum(['technical', 'financial', 'other']),
        title: z.string().trim().min(3).max(300),
        required: z.boolean(),
      }),
    )
    .max(100)
    .nullable(),
});

/**
 * The company's tender settings (docs/wave1-plan.md step 13). Everyone reads them (the decision form needs the
 * criteria); only the admin changes them. `null` restores the built-in list.
 */
@Controller('tenant/tender-settings')
@UseGuards(TenantAuthGuard)
export class TenderSettingsController {
  constructor(private readonly settings: TenderSettingsService) {}

  @Get()
  get(@Auth() c: TenantClaims) {
    return this.settings.get(c);
  }

  @Post('bid-criteria')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  setCriteria(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(criteriaBody)) b: z.infer<typeof criteriaBody>,
  ) {
    return this.settings.setCriteria(c, b.criteria);
  }

  @Post('checklist')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  setChecklist(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(checklistBody)) b: z.infer<typeof checklistBody>,
  ) {
    return this.settings.setChecklist(c, b.items);
  }
}
