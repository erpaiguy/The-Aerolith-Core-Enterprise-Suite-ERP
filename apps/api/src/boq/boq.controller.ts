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
import { BoqService, type Op } from './boq.service.js';
import { RevisionService } from './revision.service.js';

const MAX_OPS = 500;

const sortKey = z.string().regex(/^[0-9a-z!"]{1,2000}$/, 'Not a sort key');
const lineId = z.string().regex(/^\d{1,19}$/, 'Not a line id');
// A line reference in a batch: a real id, or the tempId of a line inserted earlier in the same batch.
const lineRef = z.string().regex(/^(\d{1,19}|t[\w-]{1,40})$/, 'Not a line id or temp id');
// Quantities may be negative (deductions); 4 decimals. Rates: 4 decimals (docs/05-database.md §1).
const decimal4 = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d{1,16}(\.\d{1,4})?$/.test(v), { message: 'Up to 16 digits and 4 decimals' })
  .nullable();

const lineFields = {
  rateAnalysisId: z.uuid().nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  description: z.string().max(10_000).optional(),
  notes: z.string().max(10_000).optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  qty: decimal4.optional(),
  rate: decimal4.optional(),
};

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    tempId: z.string().regex(/^t[\w-]{1,40}$/, 'tempId must start with t'),
    parentId: lineRef.nullable(),
    afterId: lineRef.nullable(),
    type: z.enum(['section', 'item', 'note']),
    ...lineFields,
  }),
  z.object({
    op: z.literal('update'),
    id: lineRef,
    rowVersion: z.number().int().positive(),
    ...lineFields,
  }),
  z.object({ op: z.literal('delete'), id: lineRef, rowVersion: z.number().int().positive() }),
  z.object({
    op: z.literal('shift'),
    id: lineRef,
    rowVersion: z.number().int().positive(),
    direction: z.enum(['up', 'down', 'in', 'out']),
  }),
  z.object({
    op: z.literal('move'),
    id: lineRef,
    rowVersion: z.number().int().positive(),
    parentId: lineRef.nullable(),
    afterId: lineRef.nullable(),
  }),
]);
const changesBody = z.object({ ops: z.array(opSchema).min(1).max(MAX_OPS) });
const freezeBody = z.object({
  kind: z.enum(['submitted', 'internal']),
  label: z.string().trim().max(100).default(''),
  note: z.string().trim().max(4000).default(''),
});
const reviseBody = z.object({ note: z.string().trim().max(4000).default('') });
const archiveBody = z.object({ archived: z.boolean() });
const compareQuery = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
  filter: z.enum(['all', 'added', 'removed', 'changed']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
const dimension = z
  .union([z.string().trim(), z.number()])
  .transform((v) => (v === '' ? null : String(v)))
  .refine((v) => v === null || /^\d{1,12}(\.\d{1,4})?$/.test(v), {
    message: 'A positive number with up to 4 decimals',
  })
  .nullable()
  .default(null);
const measurementBody = z.object({
  rowVersion: z.number().int().positive(),
  rows: z
    .array(
      z
        .object({
          description: z.string().trim().max(500).default(''),
          nos: dimension,
          length: dimension,
          breadth: dimension,
          height: dimension,
          deduct: z.boolean().default(false),
        })
        .refine((r) => [r.nos, r.length, r.breadth, r.height].some((d) => d !== null), {
          message: 'Each row needs at least one of nos, length, breadth or height',
        }),
    )
    .max(1000),
});

const windowQuery = z
  .object({
    after: sortKey.optional(),
    from: sortKey.optional(),
    before: sortKey.optional(),
    /** Read backwards from the last row (jump to the end of the BOQ). */
    end: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    collapsed: z
      .string()
      .max(20_000)
      .optional()
      .transform((v) => (v ? v.split(',').filter(Boolean) : []))
      .pipe(z.array(lineId).max(2000)),
  })
  .refine((q) => [q.after, q.from, q.before, q.end || undefined].filter(Boolean).length <= 1, {
    message: 'Use one of after, from, before or end',
  });
const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  after: sortKey.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const outlineQuery = z.object({ maxDepth: z.coerce.number().int().min(0).max(30).default(1) });
const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).default(''),
});
const headerBody = z.object({
  rowVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(4000).optional(),
  rateDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a date')
    .optional(),
});

/**
 * BOQ engine (docs/wave1-plan.md step 2). Everyone signed in can read; editing needs the `boq.edit` permission (admin-configurable per
 * role), a draft BOQ and a licence that allows changes.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class BoqController {
  constructor(
    private readonly boqs: BoqService,
    private readonly revisions: RevisionService,
  ) {}

  // --- revisions (step 7) ---

  @Get('boqs/:id/versions')
  versions(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisions.versions(c, id);
  }

  /** Freezes the current version: submitted to the client, or locked for internal review. Nothing is copied. */
  @Post('boqs/:id/freeze')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  freeze(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(freezeBody)) b: z.infer<typeof freezeBody>,
  ) {
    return this.revisions.freeze(c, id, b);
  }

  /** Starts the next revision of a frozen BOQ. */
  @Post('boqs/:id/revise')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  revise(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reviseBody)) b: z.infer<typeof reviseBody>,
  ) {
    return this.revisions.revise(c, id, b.note);
  }

  /** Archives a BOQ made by mistake (BOQs are never deleted), or restores it. */
  @Post('boqs/:id/archive')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  async archive(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(archiveBody)) b: z.infer<typeof archiveBody>,
  ) {
    await this.revisions.archive(c, id, b.archived);
    return this.boqs.header(c, id);
  }

  @Get('boqs/:id/compare')
  compare(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(compareQuery)) q: z.infer<typeof compareQuery>,
  ) {
    return this.revisions.compare(c, id, q.from, q.to, q);
  }

  @Get('tenders/:id/boqs')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) tenderId: string) {
    return this.boqs.listForTender(c, tenderId);
  }

  @Post('tenders/:id/boqs')
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) tenderId: string,
    @Body(new ZodPipe(createBody)) b: z.infer<typeof createBody>,
  ) {
    return this.boqs.create(c, tenderId, b);
  }

  @Get('boqs/:id')
  header(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.boqs.header(c, id);
  }

  @Post('boqs/:id')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  updateHeader(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(headerBody)) b: z.infer<typeof headerBody>,
  ) {
    return this.boqs.updateHeader(c, id, b.rowVersion, {
      name: b.name,
      notes: b.notes,
      rateDate: b.rateDate,
    });
  }

  @Get('boqs/:id/rows')
  rows(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(windowQuery)) q: z.infer<typeof windowQuery>,
  ) {
    return this.boqs.window(c, id, q);
  }

  @Get('boqs/:id/outline')
  outline(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(outlineQuery)) q: z.infer<typeof outlineQuery>,
  ) {
    return this.boqs.outline(c, id, q.maxDepth);
  }

  @Get('boqs/:id/search')
  search(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(searchQuery)) q: z.infer<typeof searchQuery>,
  ) {
    return this.boqs.search(c, id, q.q, q);
  }

  @Get('boqs/:id/lines/:lineId/measurements')
  measurements(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', new ZodPipe(lineId)) lineIdParam: string,
  ) {
    return this.boqs.measurements(c, id, lineIdParam);
  }

  /** Replaces the item's measurement sheet; its quantity becomes the total. */
  @Post('boqs/:id/lines/:lineId/measurements')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  setMeasurements(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', new ZodPipe(lineId)) lineIdParam: string,
    @Body(new ZodPipe(measurementBody)) b: z.infer<typeof measurementBody>,
  ) {
    return this.boqs.setMeasurements(c, id, lineIdParam, b.rowVersion, b.rows);
  }

  /** Re-price every item linked to a rate analysis, as on the BOQ's rate date. */
  @Post('boqs/:id/refresh-rates')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  refreshRates(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.boqs.refreshRates(c, id);
  }

  @Post('boqs/:id/changes')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  changes(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changesBody)) b: z.infer<typeof changesBody>,
  ) {
    return this.boqs.apply(c, id, b.ops as Op[]);
  }
}
