import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PriceIndexService } from './price-index.service.js';

const key = z.string().regex(/^[a-z0-9_]{2,40}$/, 'Lower-case letters, digits and _');

/** Index series for price escalation (docs/wave8-plan.md step 8d.1). */
@Controller('tenant/accounts/price-indices')
@UseGuards(TenantAuthGuard)
export class PriceIndexController {
  constructor(private readonly indices: PriceIndexService) {}

  @Get()
  series(@Auth() c: TenantClaims) {
    return this.indices.series(c);
  }

  @Post()
  @HttpCode(200)
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Body(
      new ZodPipe(
        z.object({
          key,
          name: z.string().trim().min(2).max(120),
          source: z.string().trim().max(200).default(''),
        }),
      ),
    )
    b: { key: string; name: string; source: string },
  ) {
    return this.indices.addSeries(c, b);
  }

  @Post(':key/values')
  @HttpCode(200)
  @RequiresFeatures()
  values(
    @Auth() c: TenantClaims,
    @Param('key') k: string,
    @Body(
      new ZodPipe(
        z.object({
          values: z
            .array(
              z.object({
                month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
                value: z
                  .union([z.string().trim(), z.number()])
                  .transform((v) => String(v))
                  .refine((v) => /^\d{1,9}(\.\d{1,4})?$/.test(v) && Number(v) > 0, {
                    message: 'An index above nothing',
                  }),
              }),
            )
            .min(1)
            .max(240),
        }),
      ),
    )
    b: { values: { month: string; value: string }[] },
  ) {
    return this.indices.setValues(c, k, b.values);
  }
}
