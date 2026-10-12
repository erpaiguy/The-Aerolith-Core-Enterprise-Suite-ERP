import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { StatutoryService } from './statutory.service.js';

const settle = z.object({
  reason: z.enum(['resigned', 'retired', 'terminated', 'contract_ended', 'died']),
  noticeDays: z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^-?\d{1,3}(\.5)?$/.test(v), { message: 'Days, in halves; negative when short' })
    .default('0'),
  leaveTypeCode: z.string().trim().toUpperCase().nullable().default(null),
});

/** Payroll's returns and the full and final settlement (docs/wave3-plan.md step 12b). */
@Controller('tenant/payroll')
@UseGuards(TenantAuthGuard)
export class StatutoryController {
  constructor(private readonly statutory: StatutoryService) {}

  /** The ECR's text, with who could not be filed (`?format=txt` for the file itself). */
  @Get('runs/:id/ecr')
  async ecr(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ format: z.enum(['json', 'txt']).default('json') })))
    q: { format: 'json' | 'txt' },
  ) {
    const e = await this.statutory.ecr(c, id);
    if (q.format === 'json') return e;
    return new StreamableFile(Buffer.from(e.text, 'utf8'), {
      type: 'text/plain; charset=utf-8',
      disposition: attachment(e.fileName),
    });
  }

  @Get('runs/:id/esi')
  async esi(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ format: z.enum(['json', 'xlsx']).default('json') })))
    q: { format: 'json' | 'xlsx' },
  ) {
    const e = await this.statutory.esi(c, id);
    if (q.format === 'json') return { fileName: e.fileName, rows: e.rows };
    return new StreamableFile(e.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(e.fileName),
    });
  }

  @Get('year-form')
  yearForm(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({ entityId: z.uuid(), year: z.coerce.number().int().min(2000).max(2100) }),
      ),
    )
    q: { entityId: string; year: number },
  ) {
    return this.statutory.yearForm(c, q.entityId, q.year);
  }

  @Get('employees/:id/settlement')
  settlement(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.statutory.settlement(c, id);
  }

  @Post('employees/:id/settlement')
  @HttpCode(200)
  @RequiresFeatures()
  settle(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(settle)) b: z.infer<typeof settle>,
  ) {
    return this.statutory.settle(c, id, b);
  }

  @Post('employees/:id/settlement/post')
  @HttpCode(200)
  @RequiresFeatures()
  postSettlement(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.statutory.postSettlement(c, id);
  }
}
