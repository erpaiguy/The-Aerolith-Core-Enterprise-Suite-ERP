import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { moneyCol, reportXlsx } from '../procurement/procurement-report-excel.js';
import { CostControlService, SOURCES } from './cost-control.service.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM');
const key = z.string().regex(/^[0-9a-f-]{0,36}\|[0-9a-f-]{0,36}$/, 'Not a row');
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'An amount in rupees');
const report = z.object({
  compare: month.optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
});
const documents = z.object({
  key: key.optional(),
  unallocated: z.enum(['true', 'false']).optional(),
});
const allocate = z.object({
  target: z.union([
    z.object({ poId: z.uuid(), lineKey: z.uuid() }),
    z.object({ voucherId: z.uuid(), position: z.number().int().positive() }),
  ]),
  wbsId: z.uuid().nullable().default(null),
  costCodeId: z.uuid().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});
const ctc = z.object({
  key,
  amount: money.nullable(),
  note: z.string().trim().max(1000).default(''),
});
const defaultBody = z.object({ costCodeId: z.uuid().nullable() });

/** Cost control (docs/wave4-plan.md step 1). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class CostControlController {
  constructor(private readonly cost: CostControlService) {}

  @Get('projects/:id/cost-control')
  async report(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(report)) q: z.infer<typeof report>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.cost.report(c, id, q.compare);
    if (q.format === 'json') return r;
    type Row = (typeof r.rows)[number];
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await reportXlsx<Row>(
        'Cost control',
        ['Cost control', 'By cost code and WBS element; computed cost to complete marked *'],
        [
          {
            header: 'Cost code',
            value: (x) => (x.costCode ? `${x.costCode.code} ${x.costCode.name}` : 'Not placed'),
          },
          { header: 'WBS', value: (x) => (x.wbs ? `${x.wbs.code} ${x.wbs.name}` : '') },
          moneyCol('Original budget', (x) => x.original),
          moneyCol('Approved changes', (x) => x.changes),
          moneyCol('Current budget', (x) => x.budget),
          moneyCol('Committed', (x) => x.committed),
          moneyCol('Actual', (x) => x.actual),
          moneyCol('Cost to complete', (x) => x.ctc),
          { header: '', value: (x) => (x.ctcComputed ? '*' : ''), width: 3 },
          moneyCol('Forecast', (x) => x.forecast),
          moneyCol('Variance', (x) => x.variance),
        ],
        r.rows,
      ),
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        disposition: attachment('cost-control.xlsx'),
      },
    );
  }

  @Get('projects/:id/cost-control/documents')
  documents(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(documents)) q: z.infer<typeof documents>,
  ) {
    return this.cost.documents(c, id, {
      ...(q.key !== undefined ? { key: q.key } : {}),
      unallocated: q.unallocated === 'true',
    });
  }

  @Post('projects/:id/cost-control/allocations')
  @HttpCode(200)
  @RequiresFeatures()
  allocate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(allocate)) b: z.infer<typeof allocate>,
  ) {
    return this.cost.allocate(c, id, b);
  }

  @Post('projects/:id/cost-control/ctc')
  @HttpCode(200)
  @RequiresFeatures()
  setCtc(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ctc)) b: z.infer<typeof ctc>,
  ) {
    return this.cost.setCtc(c, id, b.key, b.amount, b.note);
  }

  @Post('projects/:id/cost-control/baseline')
  @HttpCode(200)
  @RequiresFeatures()
  baseline(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.cost.baseline(c, id);
  }

  @Post('projects/:id/cost-control/months/:month/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('month', new ZodPipe(month)) m: string,
  ) {
    return this.cost.closeMonth(c, id, m);
  }

  @Post('cost-control/defaults/:source')
  @HttpCode(200)
  @RequiresFeatures()
  setDefault(
    @Auth() c: TenantClaims,
    @Param('source', new ZodPipe(z.enum(SOURCES))) source: (typeof SOURCES)[number],
    @Body(new ZodPipe(defaultBody)) b: z.infer<typeof defaultBody>,
  ) {
    return this.cost.setDefault(c, source, b.costCodeId);
  }
}
