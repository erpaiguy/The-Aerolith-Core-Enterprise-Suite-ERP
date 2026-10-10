import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DashboardService } from './dashboard.service.js';
import { MacroService } from './macro.service.js';
import { ProgrammeService } from './programme.service.js';

const rowVersion = z.number().int().positive();
const date = z.iso.date();
const rowId = z
  .string()
  .regex(/^(\d{1,18}|t[\w-]{0,40})$/, 'A row id or a temporary id starting with "t"');
const constraint = z
  .object({ type: z.enum(['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO']), date })
  .nullable();
const duration = z.number().int().min(0).max(36500);
const code = z.string().trim().min(1).max(40);
const name = z.string().trim().max(500);
/** Package, trade or zone of a project schedule's activity: blank clears it. */
const group = z
  .string()
  .trim()
  .max(60)
  .transform((v) => v || null)
  .nullable()
  .optional();

const op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    tempId: z.string().regex(/^t[\w-]{0,40}$/),
    parentId: rowId.nullable(),
    afterId: rowId.nullable(),
    code: code.optional(),
    name,
    duration: duration.optional(),
    calendarId: z.uuid().nullable().optional(),
    constraint: constraint.optional(),
    wbsId: z.uuid().nullable().optional(),
    package: group,
    trade: group,
    zone: group,
  }),
  z.object({
    op: z.literal('update'),
    id: rowId,
    code: code.optional(),
    name: name.optional(),
    duration: duration.optional(),
    calendarId: z.uuid().nullable().optional(),
    constraint: constraint.optional(),
    notes: z.string().max(2000).optional(),
    wbsId: z.uuid().nullable().optional(),
    package: group,
    trade: group,
    zone: group,
    progress: z
      .object({
        actualStart: date.nullable(),
        actualFinish: date.nullable().default(null),
        remaining: duration.nullable().default(null),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    op: z.literal('move'),
    id: rowId,
    parentId: rowId.nullable(),
    afterId: rowId.nullable(),
  }),
  z.object({ op: z.literal('delete'), id: rowId }),
  z.object({
    op: z.literal('link'),
    pred: rowId,
    succ: rowId,
    type: z.enum(['FS', 'SS', 'FF', 'SF']),
    lag: z.number().int().min(-3650).max(3650).default(0),
  }),
  z.object({ op: z.literal('unlink'), pred: rowId, succ: rowId }),
]);
const changes = z.object({ rowVersion, ops: z.array(op).min(1).max(5000) });
const create = z.object({ name: z.string().trim().min(1).max(200), startOn: date });
const createSchedule = create.extend({ fromWbs: z.boolean().default(false) });
const baseline = z.object({ name: z.string().trim().min(1).max(100) });
const assign = z.object({
  activityId: z.string().regex(/^\d{1,18}$/),
  resourceId: z.uuid(),
  unitsPerDay: z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d{1,10}(\.\d{1,4})?$/.test(v) && Number(v) > 0, {
      message: 'Units a working day, more than 0, up to 4 decimals',
    })
    .nullable(),
});
const weeksQuery = (max: number, dflt: number) =>
  z.object({ weeks: z.coerce.number().int().min(1).max(max).default(dflt) });
const lookaheadQuery = weeksQuery(12, 3);
const loadQuery = weeksQuery(104, 12);
const update = z.object({
  rowVersion,
  name: z.string().trim().min(1).max(200).optional(),
  startOn: date.optional(),
  calendarId: z.uuid().optional(),
  notes: z.string().trim().max(4000).optional(),
  dataDate: date.nullable().optional(),
  baselineId: z.uuid().nullable().optional(),
});
const calendar = z.object({
  rowVersion,
  name: z.string().trim().min(1).max(100),
  workWeek: z.number().int().min(0).max(127),
  holidays: z.array(date).max(2000).default([]),
  workingDays: z.array(date).max(2000).default([]),
});
const archive = z.object({ archived: z.boolean() });
const exportQuery = z.object({ format: z.enum(['mspdi', 'xer', 'xlsx']) });
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

type Claims = TenantClaims;

/**
 * Tender programmes (docs/wave1-plan.md step 11) and project schedules (docs/wave2a-plan.md step 4). Changes need
 * `programme.edit`; a tender's programmes are read by everyone, a project's schedules by its team (ProjectAccess).
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProgrammeController {
  constructor(
    private readonly programmes: ProgrammeService,
    private readonly macros: MacroService,
    private readonly dashboards: DashboardService,
  ) {}

  /** Where the project stands: money, progress three ways, the S-curve, the look-ahead and the next milestones. */
  @Get('projects/:id/dashboard')
  dashboard(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.dashboards.dashboard(c, id);
  }

  /** The project's schedules rolled up through its WBS, by package, trade and zone, and its milestones. */
  @Get('projects/:id/macro')
  macro(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.macros.macro(c, id);
  }

  /** Packages, trades and zones already used in the project's schedules. */
  @Get('projects/:id/activity-groups')
  activityGroups(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.macros.groupValues(c, id);
  }

  @Get('tenders/:id/programmes')
  list(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.programmes.list(c, id);
  }

  @Post('tenders/:id/programmes')
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  create(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    return this.programmes.create(c, id, b);
  }

  /** multipart/form-data, field `file`: an MS Project XML or Primavera XER file, imported as a new programme. */
  @Post('tenders/:id/programmes/import')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  async importFile(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.programmes.importFile(c, { tenderId: id }, await uploaded(req));
  }

  @Get('projects/:id/schedules')
  listSchedules(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.programmes.listForProject(c, id);
  }

  @Post('projects/:id/schedules')
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  createSchedule(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createSchedule)) b: z.infer<typeof createSchedule>,
  ) {
    return this.programmes.createForProject(c, id, b);
  }

  /** A project schedule from an MS Project XML or Primavera XER file. */
  @Post('projects/:id/schedules/import')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  async importSchedule(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.programmes.importFile(c, { projectId: id }, await uploaded(req));
  }

  @Post('programmes/:id/baselines')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  baseline(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(baseline)) b: z.infer<typeof baseline>,
  ) {
    return this.programmes.takeBaseline(c, id, b.name);
  }

  @Get('programmes/:id/activities/:activityId/resources')
  activityResources(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId') activityId: string,
  ) {
    if (!/^\d{1,18}$/.test(activityId))
      throw new BadRequestException({ code: 'activity_not_found' });
    return this.programmes.assignments(c, id, activityId);
  }

  @Post('programmes/:id/assignments')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  assign(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(assign)) b: z.infer<typeof assign>,
  ) {
    return this.programmes.assign(c, id, b);
  }

  /** The resources needed week by week from the data date. */
  @Get('programmes/:id/resources')
  resources(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(loadQuery)) q: z.infer<typeof loadQuery>,
  ) {
    return this.programmes.resourceLoad(c, id, q.weeks);
  }

  @Get('programmes/:id/lookahead')
  lookahead(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(lookaheadQuery)) q: z.infer<typeof lookaheadQuery>,
  ) {
    return this.programmes.lookahead(c, id, q.weeks);
  }

  /** The programme as MS Project XML, Primavera XER or Excel. Reading, so open on a read-only licence too. */
  @Get('programmes/:id/export')
  async exportFile(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(exportQuery)) q: z.infer<typeof exportQuery>,
  ) {
    const out = await this.programmes.exportFile(c, id, q.format);
    return new StreamableFile(Readable.from(out.body), {
      type: out.type,
      disposition: attachment(out.fileName),
    });
  }

  @Get('programmes/:id')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.programmes.get(c, id);
  }

  @Post('programmes/:id')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  update(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(update)) b: z.infer<typeof update>,
  ) {
    return this.programmes.update(c, id, b);
  }

  @Post('programmes/:id/changes')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  change(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changes)) b: z.infer<typeof changes>,
  ) {
    return this.programmes.change(c, id, b.rowVersion, b.ops);
  }

  @Post('programmes/:id/archive')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  archive(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(archive)) b: z.infer<typeof archive>,
  ) {
    return this.programmes.archive(c, id, b.archived);
  }

  @Post('programmes/:id/calendars')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  addCalendar(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(calendar)) b: z.infer<typeof calendar>,
  ) {
    return this.programmes.saveCalendar(c, id, null, b);
  }

  @Post('programmes/:id/calendars/:calendarId')
  @HttpCode(200)
  @RequiresPermission('programme.edit')
  @RequiresFeatures()
  saveCalendar(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('calendarId', ParseUUIDPipe) calendarId: string,
    @Body(new ZodPipe(calendar)) b: z.infer<typeof calendar>,
  ) {
    return this.programmes.saveCalendar(c, id, calendarId, b);
  }
}

/** The programme file sent as form data (field `file`). */
async function uploaded(req: FastifyRequest) {
  if (!req.isMultipart())
    throw new BadRequestException({
      code: 'not_multipart',
      message: 'Send the file as form data.',
    });
  const file = await req.file({ limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } });
  if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
  const buffer = await file.toBuffer().catch(() => null);
  if (!buffer || file.file.truncated)
    throw new BadRequestException({
      code: 'file_too_large',
      message: 'A programme file is at most 20 MB.',
    });
  return { name: file.filename, buffer };
}
