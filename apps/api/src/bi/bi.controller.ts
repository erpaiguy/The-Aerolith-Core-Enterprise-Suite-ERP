import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { BiService } from './bi.service.js';
import type { Spec } from './query.js';

const name = z.string().regex(/^[a-z_]{1,40}$/, 'A field name');
const spec = z.object({
  view: name,
  fields: z.array(name).max(30).default([]),
  filters: z
    .array(
      z.object({
        field: name,
        op: z.enum(['eq', 'ne', 'gt', 'lt', 'between', 'contains', 'in']),
        value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]),
      }),
    )
    .max(20)
    .default([]),
  groupBy: z.array(name).max(4).default([]),
  aggregates: z
    .array(z.object({ field: name, fn: z.enum(['sum', 'avg', 'count', 'min', 'max']) }))
    .max(10)
    .default([]),
  sort: z
    .object({ field: name, dir: z.enum(['asc', 'desc']) })
    .nullable()
    .default(null),
  limit: z.number().int().min(1).max(100_000).default(1000),
});
const chart = z.object({
  kind: z.enum(['table', 'bar', 'line', 'pie']),
  label: name.optional(),
  value: name.optional(),
});
const save = z.object({
  name: z.string().trim().min(2).max(120),
  spec,
  chart: chart.default({ kind: 'table' }),
  sharedWith: z.enum(['nobody', 'managers', 'everyone']).default('nobody'),
});
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The report builder (docs/wave6-plan.md step 3). */
@Controller('tenant/reports')
@UseGuards(TenantAuthGuard)
export class BiController {
  constructor(private readonly bi: BiService) {}

  @Get('views')
  views(@Auth() c: TenantClaims) {
    return this.bi.views(c);
  }

  @Post('run')
  @HttpCode(200)
  run(@Auth() c: TenantClaims, @Body(new ZodPipe(spec)) b: Spec) {
    return this.bi.run(c, b);
  }

  @Post('run.xlsx')
  @HttpCode(200)
  async xlsx(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ spec, title: z.string().trim().max(120).default('Report') })))
    b: { spec: Spec; title: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const x = await this.bi.xlsx(c, b.spec, b.title);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(x.buffer, {
      type: XLSX,
      disposition: attachment(`${b.title || 'Report'}.xlsx`.replace(/[/\\]/g, '-')),
    });
  }

  @Get('saved')
  list(@Auth() c: TenantClaims) {
    return this.bi.list(c);
  }

  @Post('saved')
  @HttpCode(200)
  @RequiresFeatures()
  create(@Auth() c: TenantClaims, @Body(new ZodPipe(save)) b: z.infer<typeof save>) {
    return this.bi.save(c, null, b as never);
  }

  @Get('saved/:id')
  open(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.bi.open(c, id);
  }

  @Post('saved/:id')
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(save)) b: z.infer<typeof save>,
  ) {
    return this.bi.save(c, id, b as never);
  }

  @Post('saved/:id/delete')
  @HttpCode(200)
  @RequiresFeatures()
  remove(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.bi.remove(c, id);
  }

  @Post('saved/:id/schedules')
  @HttpCode(200)
  @RequiresFeatures()
  schedule(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          weekday: z.number().int().min(1).max(7).nullable().default(null),
          monthday: z.number().int().min(1).max(28).nullable().default(null),
          recipients: z.array(z.uuid()).max(50).default([]),
        }),
      ),
    )
    b: {
      cadence: 'daily' | 'weekly' | 'monthly';
      weekday: number | null;
      monthday: number | null;
      recipients: string[];
    },
  ) {
    return this.bi.schedule(c, id, b);
  }

  @Post('schedules/:id/delete')
  @HttpCode(200)
  @RequiresFeatures()
  unschedule(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.bi.unschedule(c, id);
  }

  @Get('exports/:id')
  async exportFile(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const e = await this.bi.export(c, id);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(e.bytes, { type: XLSX, disposition: attachment(e.fileName) });
  }
}
