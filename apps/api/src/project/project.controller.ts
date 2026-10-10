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
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { day, money, text } from '../tender/tender.controller.js';
import { PROJECT_STATUSES } from './project-rules.js';
import { ProjectService } from './project.service.js';

const rowVersion = z.number().int().positive();
const projectFields = {
  name: z.string().trim().min(3).max(300),
  clientId: z.uuid().nullable(),
  clientRef: text(200),
  contractValue: money,
  startOn: day,
  plannedFinishOn: day,
  actualFinishOn: day,
  location: text(300),
  description: z.string().trim().max(8000),
};
const projectCreate = z.object({
  name: projectFields.name,
  clientId: projectFields.clientId.default(null),
  clientRef: projectFields.clientRef.default(null),
  contractValue: projectFields.contractValue.default(null),
  startOn: projectFields.startOn.default(null),
  plannedFinishOn: projectFields.plannedFinishOn.default(null),
  actualFinishOn: projectFields.actualFinishOn.default(null),
  location: projectFields.location.default(null),
  description: projectFields.description.default(''),
});
const projectUpdate = z.object(projectFields).partial().extend({ rowVersion });
const fromTender = z.object({
  name: projectFields.name.optional(),
  clientRef: projectFields.clientRef.optional(),
  startOn: projectFields.startOn.optional(),
  plannedFinishOn: projectFields.plannedFinishOn.optional(),
});
const statusBody = z.object({
  rowVersion,
  status: z.enum(PROJECT_STATUSES),
  reason: text(2000).default(null),
});
const listQuery = z.object({
  status: z.enum(['live', ...PROJECT_STATUSES]).optional(),
  q: z.string().max(200).optional(),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
const siteFields = {
  name: z.string().trim().min(2).max(200),
  address: text(1000),
  stateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'The 2-digit GST state code, e.g. 27 for Maharashtra')
    .nullable()
    .or(z.literal('').transform(() => null)),
  active: z.boolean(),
};
const siteCreate = z.object({
  name: siteFields.name,
  address: siteFields.address.default(null),
  stateCode: siteFields.stateCode.default(null),
  active: siteFields.active.default(true),
});
const siteUpdate = z.object(siteFields).partial().extend({ rowVersion });
const memberBody = z.object({
  userId: z.uuid(),
  /** null takes them off the team. */
  role: z.enum(['lead', 'member', 'viewer']).nullable(),
});

/**
 * Projects (docs/wave2a-plan.md step 1). Each project is visible to its team, and to roles that see every project;
 * its lead and roles that edit projects change it (checked per project in the service).
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get('projects')
  list(@Auth() c: TenantClaims, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.projects.list(c, q);
  }

  @Post('projects')
  @RequiresPermission('projects.edit')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(projectCreate)) b: z.infer<typeof projectCreate>,
  ) {
    return this.projects.create(c, b);
  }

  @Get('projects/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(c, id);
  }

  @Post('projects/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(projectUpdate)) b: z.infer<typeof projectUpdate>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.projects.update(c, id, v, input);
  }

  @Post('projects/:id/status')
  @HttpCode(200)
  @RequiresFeatures()
  status(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(statusBody)) b: z.infer<typeof statusBody>,
  ) {
    return this.projects.setStatus(c, id, b.rowVersion, b.status, b.reason);
  }

  @Post('projects/:id/sites')
  @HttpCode(200)
  @RequiresFeatures()
  addSite(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(siteCreate)) b: z.infer<typeof siteCreate>,
  ) {
    return this.projects.addSite(c, id, b);
  }

  @Post('sites/:id')
  @HttpCode(200)
  @RequiresFeatures()
  updateSite(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(siteUpdate)) b: z.infer<typeof siteUpdate>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.projects.updateSite(c, id, v, input);
  }

  @Post('projects/:id/team')
  @HttpCode(200)
  @RequiresFeatures()
  team(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(memberBody)) b: z.infer<typeof memberBody>,
  ) {
    return this.projects.setMember(c, id, b.userId, b.role);
  }

  /** The project made from this tender, if any (for the tender page). */
  @Get('tenders/:id/project')
  forTender(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.forTender(c, id);
  }

  @Post('tenders/:id/project')
  @RequiresPermission('projects.edit')
  @RequiresFeatures()
  fromTender(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(fromTender)) b: z.infer<typeof fromTender>,
  ) {
    return this.projects.fromTender(c, id, b);
  }
}
