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
import { TemplateService } from './template.service.js';

const vertical = z.enum(['buildings', 'interiors', 'joinery', 'mep', 'other']);
const name = z.string().trim().min(1).max(200);
const saveBody = z.object({
  name,
  vertical: vertical.default('buildings'),
  description: z.string().trim().max(4000).default(''),
  withQuantities: z.boolean().default(false),
  withRates: z.boolean().default(false),
});
const updateBody = z.object({
  rowVersion: z.number().int().positive(),
  name: name.optional(),
  vertical: vertical.optional(),
  description: z.string().trim().max(4000).optional(),
});
const listQuery = z.object({
  vertical: vertical.optional(),
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
const fromTemplate = z.object({
  templateId: z.uuid(),
  name,
  notes: z.string().trim().max(4000).default(''),
});
const archiveBody = z.object({ archived: z.boolean() });

type Claims = TenantClaims;

/** BOQ templates (docs/wave1-plan.md step 13). Everyone may read them; saving, changing and using need `boq.edit`. */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  @Get('boq-templates')
  list(@Auth() c: Claims, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.templates.list(c, q);
  }

  @Get('boq-templates/:id')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(c, id);
  }

  @Post('boqs/:id/save-as-template')
  @HttpCode(201)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  save(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(saveBody)) b: z.infer<typeof saveBody>,
  ) {
    return this.templates.saveFrom(c, id, b);
  }

  @Post('boq-templates/:id')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  update(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateBody)) b: z.infer<typeof updateBody>,
  ) {
    const { rowVersion, ...input } = b;
    return this.templates.update(c, id, rowVersion, input);
  }

  @Post('boq-templates/:id/archive')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  archive(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(archiveBody)) b: z.infer<typeof archiveBody>,
  ) {
    return this.templates.archive(c, id, b.archived);
  }

  @Post('tenders/:id/boqs/from-template')
  @HttpCode(201)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  fromTemplate(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) tenderId: string,
    @Body(new ZodPipe(fromTemplate)) b: z.infer<typeof fromTemplate>,
  ) {
    return this.templates.createBoq(c, tenderId, b);
  }
}
