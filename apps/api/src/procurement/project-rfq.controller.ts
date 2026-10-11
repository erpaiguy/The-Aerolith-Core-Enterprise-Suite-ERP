import {
  Body,
  Controller,
  ForbiddenException,
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
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { RfqService } from '../rfq/rfq.service.js';

const create = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(['work', 'material']).default('material'),
  dueOn: z.iso.date().nullable().default(null),
  terms: z.string().trim().max(8000).default(''),
  requisitionIds: z.array(z.uuid()).max(100).default([]),
});

/**
 * A project's enquiries to vendors (docs/wave2b-plan.md step 3): Wave 1's RFQs, owned by the project. Its team reads
 * them; its leads and members with `rfq.edit` start them. Everything after (lines, vendors, quotes, the comparative
 * statement, the choice) goes through the RFQ routes, kept to the team by ProjectAccess.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProjectRfqController {
  constructor(
    private readonly rfqs: RfqService,
    private readonly projects: ProjectService,
    private readonly tenants: TenantConnections,
  ) {}

  @Get('projects/:id/rfqs')
  async list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    const db = await this.tenants.forTenant(c.ten);
    await this.projects.access(db, c, id);
    return this.rfqs.listForProject(c, id);
  }

  @Post('projects/:id/rfqs')
  @HttpCode(200)
  @RequiresPermission('rfq.edit')
  @RequiresFeatures()
  async create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    const db = await this.tenants.forTenant(c.ten);
    const a = await this.projects.access(db, c, id);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) sends its enquiries.",
      });
    return this.rfqs.createForProject(c, id, b);
  }
}
