import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RESOURCE_KINDS } from './engine.js';
import { RatesService } from './rates.service.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a date');
const today = () => new Date().toISOString().slice(0, 10);
const decimal = (places: number, digits = 16) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => new RegExp(`^\\d{1,${digits}}(\\.\\d{1,${places}})?$`).test(v), {
      message: `A number with up to ${places} decimals`,
    });
const code = z.string().trim().min(1).max(40);
const unit = z.string().trim().min(1).max(20);
const kind = z.enum(RESOURCE_KINDS as [string, ...string[]]) as z.ZodType<
  (typeof RESOURCE_KINDS)[number]
>;
const activeFilter = z.enum(['true', 'false', 'all']).default('true');
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};

const resourceList = z.object({
  q: z.string().trim().max(100).optional(),
  kind: kind.optional(),
  active: activeFilter,
  asOf: isoDate.default(today),
  ...page,
});
const resourceBody = z.object({
  code,
  name: z.string().trim().min(1).max(500),
  kind,
  unit,
  notes: z.string().trim().max(4000).default(''),
  rate: decimal(4).optional(),
  effectiveFrom: isoDate.optional(),
  source: z.string().trim().max(200).default(''),
});
const resourceUpdate = z.object({
  rowVersion: z.number().int().positive(),
  code: code.optional(),
  name: z.string().trim().min(1).max(500).optional(),
  kind: kind.optional(),
  unit: unit.optional(),
  notes: z.string().trim().max(4000).optional(),
  active: z.boolean().optional(),
});
const rateBody = z.object({
  effectiveFrom: isoDate,
  rate: decimal(4),
  source: z.string().trim().max(200).default(''),
});
const rateDelete = z.object({ effectiveFrom: isoDate });
const priceBookQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  effectiveFrom: isoDate.default(today),
  defaultKind: kind.default('material'),
});

const analysisList = z.object({
  q: z.string().trim().max(100).optional(),
  active: activeFilter,
  asOf: isoDate.default(today),
  ...page,
});
const asOfQuery = z.object({ asOf: isoDate.default(today) });
const line = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resource'),
    resourceId: z.uuid(),
    description: z.string().trim().max(500).default(''),
    qty: decimal(6, 14),
    wastagePct: decimal(4, 3)
      .default('0')
      .refine((v) => Number(v) <= 100, 'At most 100 %'),
  }),
  z.object({
    kind: z.literal('analysis'),
    subAnalysisId: z.uuid(),
    description: z.string().trim().max(500).default(''),
    qty: decimal(6, 14),
    wastagePct: decimal(4, 3)
      .default('0')
      .refine((v) => Number(v) <= 100, 'At most 100 %'),
  }),
  z.object({
    kind: z.literal('lump_sum'),
    description: z.string().trim().min(1).max(500),
    amount: decimal(4),
  }),
]);
const analysisBody = z.object({
  code,
  description: z.string().trim().min(1).max(10_000),
  unit,
  outputQty: decimal(4).refine((v) => Number(v) > 0, 'Must be more than 0'),
  additions: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        pct: decimal(4, 4).refine((v) => Number(v) <= 1000, 'At most 1000 %'),
      }),
    )
    .max(10)
    .default([]),
  notes: z.string().trim().max(4000).default(''),
  active: z.boolean().default(true),
  lines: z.array(line).max(300),
});
const analysisUpdate = analysisBody.extend({ rowVersion: z.number().int().positive() });
const copyBody = z.object({ code });
const previewQuery = z.object({ asOf: isoDate.default(today), id: z.uuid().optional() });

type LineIn = z.infer<typeof line>;
const toLine = (l: LineIn) => ({
  kind: l.kind,
  resourceId: l.kind === 'resource' ? l.resourceId : null,
  subAnalysisId: l.kind === 'analysis' ? l.subAnalysisId : null,
  description: l.description,
  qty: l.kind === 'lump_sum' ? '0' : l.qty,
  wastagePct: l.kind === 'lump_sum' ? '0' : l.wastagePct,
  amount: l.kind === 'lump_sum' ? l.amount : null,
});

/** Rate library (E1) and rate analysis (E2). Everyone signed in can read; changes need `rates.edit`. */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class RatesController {
  constructor(
    private readonly rates: RatesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('resources')
  resources(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(resourceList)) q: z.infer<typeof resourceList>,
  ) {
    return this.rates.listResources(c, q);
  }

  @Post('resources')
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  createResource(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(resourceBody)) b: z.infer<typeof resourceBody>,
  ) {
    return this.rates.createResource(c, b);
  }

  /** multipart/form-data, field `file`. `dryRun=true` (default) only reports what would change. */
  @Post('resources/price-book')
  @HttpCode(200)
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  async priceBook(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(priceBookQuery)) q: z.infer<typeof priceBookQuery>,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({ limits: { fileSize: this.config.importMaxBytes, files: 1 } });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    return this.rates.importPriceBook(
      c,
      { filename: file.filename, stream: file.file, truncated: () => file.file.truncated },
      q,
    );
  }

  @Get('resources/:id')
  resource(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.rates.getResource(c, id);
  }

  @Post('resources/:id')
  @HttpCode(200)
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  updateResource(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resourceUpdate)) b: z.infer<typeof resourceUpdate>,
  ) {
    const { rowVersion, ...fields } = b;
    return this.rates.updateResource(c, id, rowVersion, fields);
  }

  @Post('resources/:id/rates')
  @HttpCode(200)
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  setRate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rateBody)) b: z.infer<typeof rateBody>,
  ) {
    return this.rates.setRate(c, id, b);
  }

  @Post('resources/:id/rates/delete')
  @HttpCode(200)
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  deleteRate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rateDelete)) b: z.infer<typeof rateDelete>,
  ) {
    return this.rates.deleteRate(c, id, b.effectiveFrom);
  }

  @Get('rate-analyses')
  analyses(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(analysisList)) q: z.infer<typeof analysisList>,
  ) {
    return this.rates.listAnalyses(c, q);
  }

  @Post('rate-analyses')
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  createAnalysis(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(analysisBody)) b: z.infer<typeof analysisBody>,
  ) {
    return this.rates.createAnalysis(c, { ...b, lines: b.lines.map(toLine) });
  }

  /** Costs an analysis without saving it: the editor's live totals. `id` is the analysis being edited. */
  @Post('rate-analyses/preview')
  @HttpCode(200)
  preview(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(previewQuery)) q: z.infer<typeof previewQuery>,
    @Body(new ZodPipe(analysisBody)) b: z.infer<typeof analysisBody>,
  ) {
    return this.rates.previewAnalysis(
      c,
      q.id ?? null,
      { ...b, lines: b.lines.map(toLine) },
      q.asOf,
    );
  }

  @Get('rate-analyses/:id')
  analysis(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(asOfQuery)) q: z.infer<typeof asOfQuery>,
  ) {
    return this.rates.getAnalysis(c, id, q.asOf);
  }

  @Post('rate-analyses/:id')
  @HttpCode(200)
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  updateAnalysis(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(analysisUpdate)) b: z.infer<typeof analysisUpdate>,
  ) {
    const { rowVersion, ...rest } = b;
    return this.rates.updateAnalysis(c, id, rowVersion, { ...rest, lines: rest.lines.map(toLine) });
  }

  @Post('rate-analyses/:id/copy')
  @RequiresPermission('rates.edit')
  @RequiresFeatures()
  copy(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(copyBody)) b: z.infer<typeof copyBody>,
  ) {
    return this.rates.copyAnalysis(c, id, b.code);
  }
}
