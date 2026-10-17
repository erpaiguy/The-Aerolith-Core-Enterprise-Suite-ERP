import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DigestService } from './digest.service.js';

const settings = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .transform((v) => v || null)
    .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
      message: 'An email address',
    })
    .nullable(),
  enabled: z.boolean(),
});

/** The person's own morning digest (docs/wave8-plan.md step 8g.3): address, on or off, and today's preview. */
@Controller('tenant/me/digest')
@UseGuards(TenantAuthGuard)
export class DigestController {
  constructor(private readonly digest: DigestService) {}

  @Get()
  get(@Auth() c: TenantClaims) {
    return this.digest.settings(c);
  }

  @Post()
  @HttpCode(200)
  set(@Auth() c: TenantClaims, @Body(new ZodPipe(settings)) b: z.infer<typeof settings>) {
    return this.digest.setSettings(c, b);
  }
}
