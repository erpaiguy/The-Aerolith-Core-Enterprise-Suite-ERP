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
import { ProjectBoqService } from './project-boq.service.js';

const fromTender = z.object({ matchContractValue: z.boolean().default(false) });
const create = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['contract', 'budget']),
  notes: z.string().trim().max(4000).default(''),
});

/**
 * A project's BOQs (docs/wave2a-plan.md step 2): its contract BOQ and budget. Seen by the project's team; making them
 * needs `boq.edit` as well. Once made they are ordinary BOQs under `/boqs/:id`.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProjectBoqController {
  constructor(private readonly boqs: ProjectBoqService) {}

  @Get('projects/:id/boqs')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.boqs.list(c, id);
  }

  @Post('projects/:id/boqs')
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    return this.boqs.create(c, id, b);
  }

  /** What copying the tender's BOQs would give, before doing it. */
  @Get('projects/:id/boqs/from-tender')
  preview(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.boqs.preview(c, id);
  }

  @Post('projects/:id/boqs/from-tender')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  fromTender(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(fromTender)) b: z.infer<typeof fromTender>,
  ) {
    return this.boqs.fromTender(c, id, b);
  }

  @Get('projects/:id/boq-summary')
  summary(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.boqs.summary(c, id);
  }
}
