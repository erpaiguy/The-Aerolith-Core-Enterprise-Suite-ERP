import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TENDER_STATUSES } from '../tender/tender-rules.js';
import { analysisReportXlsx, costSummaryXlsx, pipelineXlsx } from './report-excel.js';
import { ReportsService, type BoqHead } from './reports.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const pipelineQuery = z.object({
  fy: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'A financial year looks like 2026-27')
    .optional(),
  status: z.enum(['open', 'all', ...TENDER_STATUSES]).optional(),
  vertical: z.enum(['buildings', 'interiors', 'joinery', 'mep', 'other']).optional(),
  owner: z.uuid().optional(),
});

const fileName = (b: BoqHead, what: string) =>
  `${`${b.tender.number} ${b.name} - ${what}`.replace(/[^\w.\- ()&]+/g, '_').trim() || 'report'}.xlsx`;
const xlsx = (body: Buffer, name: string) =>
  new StreamableFile(body, { type: XLSX, disposition: attachment(name) });

type Claims = TenantClaims;

/**
 * Reports (docs/wave1-plan.md step 12). Reading: everyone signed in, also on a read-only licence. Bid values inside
 * them need `pricing.edit`, which the service checks and leaves out otherwise.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('boqs/:id/cost-summary')
  costSummary(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.costSummary(c, id);
  }

  @Get('boqs/:id/cost-summary/export')
  async costSummaryFile(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.reports.costSummary(c, id);
    return xlsx(await costSummaryXlsx(s), fileName(s.boq, 'cost summary'));
  }

  @Get('boqs/:id/analysis-report')
  analysisReport(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.analysisReport(c, id);
  }

  @Get('boqs/:id/analysis-report/export')
  async analysisReportFile(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.reports.analysisReport(c, id);
    return xlsx(await analysisReportXlsx(r), fileName(r.boq, 'rate analyses'));
  }

  @Get('reports/pipeline')
  pipeline(@Auth() c: Claims, @Query(new ZodPipe(pipelineQuery)) q: z.infer<typeof pipelineQuery>) {
    return this.reports.pipeline(c, {
      fy: q.fy,
      status: q.status,
      vertical: q.vertical,
      ownerId: q.owner,
    });
  }

  @Get('reports/pipeline/export')
  async pipelineFile(
    @Auth() c: Claims,
    @Query(new ZodPipe(pipelineQuery)) q: z.infer<typeof pipelineQuery>,
  ) {
    const p = await this.reports.pipeline(c, {
      fy: q.fy,
      status: q.status,
      vertical: q.vertical,
      ownerId: q.owner,
    });
    return xlsx(await pipelineXlsx(p), `Bid pipeline${q.fy ? ` ${q.fy}` : ''}.xlsx`);
  }
}
