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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard } from '../auth/permissions.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ProgressService } from './progress.service.js';

const date = z.iso.date();
const dimension = z
  .union([z.string().trim(), z.number()])
  .transform((v) => (v === '' ? null : String(v)))
  .refine((v) => v === null || /^\d{1,12}(\.\d{1,4})?$/.test(v), { message: 'A positive number' })
  .nullable()
  .default(null);
const entry = z
  .object({
    measuredOn: date,
    qty: z
      .union([z.string().trim(), z.number()])
      .transform((v) => String(v))
      .refine((v) => /^-?\d{1,14}(\.\d{1,4})?$/.test(v), { message: 'Up to 4 decimals' })
      .optional(),
    dims: z
      .array(
        z.object({
          description: z.string().trim().max(200).default(''),
          nos: dimension,
          length: dimension,
          breadth: dimension,
          height: dimension,
          deduct: z.boolean().default(false),
        }),
      )
      .max(200)
      .optional(),
    description: z.string().trim().max(500).default(''),
  })
  .refine((e) => e.qty !== undefined || (e.dims?.length ?? 0) > 0, {
    message: 'Give a quantity or its dimensions',
  });
const reverse = z.object({ reason: z.string().trim().min(3).max(300) });
const period = z.object({ from: date.optional(), to: date.optional() });
const link = z.object({ boqId: z.uuid(), code: z.string().trim().min(1).max(40) });
const unlink = z.object({ lineKey: z.uuid() });
const lineId = (v: string) => {
  if (!/^\d{1,18}$/.test(v)) throw new BadRequestException({ code: 'line_not_found' });
  return v;
};

/**
 * Progress measurement (docs/wave2a-plan.md step 6): the measurement book of a contract BOQ's items, the project's
 * progress report, and the items a schedule activity carries out. Kept to the project's team (ProjectAccess and the
 * service); recorded by its leads and members.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('boqs/:id/lines/:lineId/progress')
  book(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId') line: string,
  ) {
    return this.progress.book(c, id, lineId(line));
  }

  @Post('boqs/:id/lines/:lineId/progress')
  @HttpCode(200)
  @RequiresFeatures()
  record(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId') line: string,
    @Body(new ZodPipe(entry)) b: z.infer<typeof entry>,
  ) {
    return this.progress.record(c, id, lineId(line), b);
  }

  @Post('boqs/:id/progress/:entryId/reverse')
  @HttpCode(200)
  @RequiresFeatures()
  reverse(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body(new ZodPipe(reverse)) b: z.infer<typeof reverse>,
  ) {
    return this.progress.reverse(c, id, entryId, b.reason);
  }

  /** Work done to `to` (default today in India) and in `from`..`to` (default: from the first of that month). */
  @Get('projects/:id/progress')
  report(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(period)) q: z.infer<typeof period>,
  ) {
    const to = q.to ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const from = q.from ?? `${to.slice(0, 8)}01`;
    if (from > to)
      throw new BadRequestException({
        code: 'bad_period',
        message: 'The period starts after it ends.',
      });
    return this.progress.report(c, id, from, to);
  }

  @Get('programmes/:id/activities/:activityId/lines')
  activityLines(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId') activityId: string,
  ) {
    return this.progress.activityLines(c, id, lineId(activityId));
  }

  @Post('programmes/:id/activities/:activityId/lines')
  @HttpCode(200)
  @RequiresFeatures()
  link(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(link)) b: z.infer<typeof link>,
  ) {
    return this.progress.link(c, id, lineId(activityId), b);
  }

  @Post('programmes/:id/activities/:activityId/lines/remove')
  @HttpCode(200)
  @RequiresFeatures()
  unlink(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(unlink)) b: z.infer<typeof unlink>,
  ) {
    return this.progress.unlink(c, id, lineId(activityId), b.lineKey);
  }
}
