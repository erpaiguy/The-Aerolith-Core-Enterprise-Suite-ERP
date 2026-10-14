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
import { SiteWalkService, type WalkInput } from './site-walk.service.js';

/** Safety inspections: site walks and their findings (docs/wave7-plan.md step 7d.5). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SiteWalkController {
  constructor(private readonly walks: SiteWalkService) {}

  @Get('projects/:id/site-walks')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.walks.list(c, id);
  }

  @Post('projects/:id/site-walks')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          walkedOn: z.iso.date(),
          area: z.string().trim().min(2).max(300),
          walkedBy: z.string().trim().max(300).default(''),
          checklistId: z.uuid().nullable().default(null),
          note: z.string().trim().max(4000).default(''),
          findings: z
            .array(
              z.object({
                observation: z.string().trim().min(2).max(1000),
                severity: z.enum(['low', 'medium', 'high']).default('medium'),
                action: z.string().trim().max(1000).default(''),
                ownerId: z.uuid(),
                dueOn: z.iso.date(),
              }),
            )
            .max(200)
            .default([]),
        }),
      ),
    )
    b: WalkInput,
  ) {
    return this.walks.create(c, id, b);
  }

  @Get('site-walks/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.walks.get(c, id);
  }

  @Post('walk-findings/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          closedOn: z.iso.date(),
          closure: z.string().trim().min(2).max(1000),
        }),
      ),
    )
    b: { closedOn: string; closure: string },
  ) {
    return this.walks.close(c, id, b);
  }
}
