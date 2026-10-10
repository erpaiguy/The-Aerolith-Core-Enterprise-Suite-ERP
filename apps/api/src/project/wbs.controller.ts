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
import { COST_KINDS, CostCodeService } from './cost-code.service.js';
import { WbsService } from './wbs.service.js';

const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/, 'Letters, digits and . _ / - (up to 40)');
const rowVersion = z.number().int().positive();
const sortKey = z.string().regex(/^[0-9a-z!"]{1,2000}$/, 'Not a sort key');

const costCodeCreate = z.object({
  parentId: z.uuid().nullable().default(null),
  code,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(COST_KINDS).default('other'),
  active: z.boolean().default(true),
});
const costCodeUpdate = costCodeCreate
  .extend({
    parentId: z.uuid().nullable(),
    kind: z.enum(COST_KINDS),
    active: z.boolean(),
  })
  .partial()
  .extend({ rowVersion });
const wbsCreate = z.object({
  parentId: z.uuid().nullable().default(null),
  code,
  name: z.string().trim().min(1).max(300),
});
const wbsUpdate = z
  .object({ parentId: z.uuid().nullable(), code, name: z.string().trim().min(1).max(300) })
  .partial()
  .extend({ rowVersion });
const moveBody = z.object({ direction: z.enum(['up', 'down']) });
const fromBoq = z.object({ boqId: z.uuid(), depth: z.number().int().min(1).max(6).default(2) });
const mapBody = z.object({
  from: sortKey,
  to: sortKey,
  wbsId: z.uuid().nullable().optional(),
  costCodeId: z.uuid().nullable().optional(),
});

/**
 * WBS and cost codes (docs/wave2a-plan.md step 3). The company's cost codes are read by everyone and changed with
 * `costcodes.edit`; a project's WBS is shaped by its lead (or editors of projects) and its BOQ lines are mapped by its
 * team (checked per project in the service, and on BOQ routes by ProjectAccess).
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class WbsController {
  constructor(
    private readonly wbs: WbsService,
    private readonly costCodes: CostCodeService,
  ) {}

  @Get('cost-codes')
  listCostCodes(@Auth() c: TenantClaims) {
    return this.costCodes.list(c);
  }

  @Post('cost-codes')
  @RequiresPermission('costcodes.edit')
  @RequiresFeatures()
  createCostCode(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(costCodeCreate)) b: z.infer<typeof costCodeCreate>,
  ) {
    return this.costCodes.create(c, b);
  }

  /** The standard list, into a company without cost codes. */
  @Post('cost-codes/standard')
  @HttpCode(200)
  @RequiresPermission('costcodes.edit')
  @RequiresFeatures()
  standardCostCodes(@Auth() c: TenantClaims) {
    return this.costCodes.loadStandard(c);
  }

  @Post('cost-codes/:id')
  @HttpCode(200)
  @RequiresPermission('costcodes.edit')
  @RequiresFeatures()
  updateCostCode(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(costCodeUpdate)) b: z.infer<typeof costCodeUpdate>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.costCodes.update(c, id, v, input);
  }

  @Get('projects/:id/wbs')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.wbs.list(c, id);
  }

  @Post('projects/:id/wbs')
  @HttpCode(200)
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(wbsCreate)) b: z.infer<typeof wbsCreate>,
  ) {
    return this.wbs.add(c, id, b);
  }

  @Post('projects/:id/wbs/from-boq')
  @HttpCode(200)
  @RequiresFeatures()
  fromBoq(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(fromBoq)) b: z.infer<typeof fromBoq>,
  ) {
    return this.wbs.fromBoq(c, id, b.boqId, b.depth);
  }

  @Get('projects/:id/breakdown')
  breakdown(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.wbs.breakdown(c, id);
  }

  @Post('wbs/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(wbsUpdate)) b: z.infer<typeof wbsUpdate>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.wbs.update(c, id, v, input);
  }

  @Post('wbs/:id/move')
  @HttpCode(200)
  @RequiresFeatures()
  move(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(moveBody)) b: z.infer<typeof moveBody>,
  ) {
    return this.wbs.move(c, id, b.direction);
  }

  @Post('wbs/:id/delete')
  @HttpCode(200)
  @RequiresFeatures()
  remove(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.wbs.remove(c, id);
  }

  /** Maps the items among a range of lines of a project BOQ to a WBS element and/or a cost code. */
  @Post('boqs/:id/mapping')
  @HttpCode(200)
  @RequiresFeatures()
  map(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(mapBody)) b: z.infer<typeof mapBody>,
  ) {
    return this.wbs.map(c, id, b);
  }
}
