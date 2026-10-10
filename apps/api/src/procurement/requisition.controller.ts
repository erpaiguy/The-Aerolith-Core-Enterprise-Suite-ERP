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
import { ZodPipe } from '../common/zod.pipe.js';
import { RequisitionService } from './requisition.service.js';

const date = z.iso.date();
const decimal = (max: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^\\d{1,14}(\\.\\d{1,${max}})?$`).test(v), {
      message: `A number with up to ${max} decimals`,
    });
const code = z
  .string()
  .trim()
  .max(40)
  .transform((v) => v || null)
  .nullable()
  .default(null);
const body = z.object({
  title: z.string().trim().min(3).max(300),
  siteId: z.uuid().nullable().default(null),
  neededBy: date.nullable().default(null),
  notes: z.string().trim().max(4000).default(''),
  lines: z
    .array(
      z.object({
        resourceId: z.uuid().nullable().default(null),
        description: z.string().trim().max(500).default(''),
        unit: z.string().trim().max(20).default(''),
        qty: decimal(4).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        rate: decimal(4).nullable().default(null),
        boqCode: code,
        wbsCode: code,
        neededBy: date.nullable().default(null),
        notes: z.string().trim().max(1000).default(''),
      }),
    )
    .max(500),
});
const update = body.extend({ rowVersion: z.number().int().positive() });
const submit = z.object({ rowVersion: z.number().int().positive() });
const cancel = z.object({ reason: z.string().trim().min(3).max(2000) });
const list = z.object({
  projectId: z.uuid().optional(),
  status: z.enum(['open', 'draft', 'submitted', 'approved', 'rejected', 'cancelled']).optional(),
});

/** Purchase requisitions (docs/wave2b-plan.md step 1). Kept to each project's team by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class RequisitionController {
  constructor(private readonly requisitions: RequisitionService) {}

  @Get('requisitions')
  list(@Auth() c: TenantClaims, @Query(new ZodPipe(list)) q: z.infer<typeof list>) {
    return this.requisitions.list(c, q);
  }

  @Post('projects/:id/requisitions')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(body)) b: z.infer<typeof body>,
  ) {
    return this.requisitions.create(c, id, b);
  }

  @Get('requisitions/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.requisitions.get(c, id);
  }

  @Post('requisitions/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    const { rowVersion, ...input } = b;
    return this.requisitions.update(c, id, rowVersion, input);
  }

  @Post('requisitions/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submit)) b: z.infer<typeof submit>,
  ) {
    return this.requisitions.submit(c, id, b.rowVersion);
  }

  @Post('requisitions/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cancel)) b: z.infer<typeof cancel>,
  ) {
    return this.requisitions.cancel(c, id, b.reason);
  }
}
