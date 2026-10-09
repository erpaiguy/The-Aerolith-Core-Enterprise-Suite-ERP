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
const update = z.object({
  rowVersion,
  name: z.string().trim().min(1).max(200).optional(),
  startOn: date.optional(),
  calendarId: z.uuid().optional(),
  notes: z.string().trim().max(4000).optional(),
});
const calendar = z.object({
  rowVersion,
  name: z.string().trim().min(1).max(100),
  workWeek: z.number().int().min(0).max(127),
  holidays: z.array(date).max(2000).default([]),
  workingDays: z.array(date).max(2000).default([]),
});
const archive = z.object({ archived: z.boolean() });

type Claims = TenantClaims;

/** Tender programmes (docs/wave1-plan.md step 11). Everyone reads; changes need `programme.edit`. */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProgrammeController {
  constructor(private readonly programmes: ProgrammeService) {}

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
