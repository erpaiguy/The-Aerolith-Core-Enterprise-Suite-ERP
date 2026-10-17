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
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { Idempotent } from '../common/idempotency.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { progressXlsx } from './progress-excel.js';
import { ProgressService } from './progress.service.js';
import { MbProposalService } from './mb-proposal.service.js';

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
const periodOf = (q: z.infer<typeof period>) => {
  const to = q.to ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (from > to)
    throw new BadRequestException({
      code: 'bad_period',
      message: 'The period starts after it ends.',
    });
  return { from, to };
};
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
  constructor(
    private readonly proposals: MbProposalService,
    private readonly progress: ProgressService,
    private readonly tenants: TenantConnections,
  ) {}

  @Get('boqs/:id/lines/:lineId/progress')
  book(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId') line: string,
  ) {
    return this.progress.book(c, id, lineId(line));
  }

  @Post('boqs/:id/lines/:lineId/progress')
  @Idempotent()
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
    const { from, to } = periodOf(q);
    return this.progress.report(c, id, from, to);
  }

  /** The same report as an Excel workbook. */
  @Get('projects/:id/progress/export')
  async reportFile(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(period)) q: z.infer<typeof period>,
  ) {
    const { from, to } = periodOf(q);
    const r = await this.progress.report(c, id, from, to);
    const db = await this.tenants.forTenant(c.ten);
    const [p] = await db<{ number: string; name: string }[]>`
      SELECT number, name FROM proj.project WHERE id = ${id}`;
    const name = `${p!.number} ${p!.name} - progress to ${to}`
      .replace(/[^\w.\- ()&]+/g, '_')
      .trim();
    return new StreamableFile(await progressXlsx(p!, r), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(`${name}.xlsx`),
    });
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

  /** The month's quantities from the daily reports, to put in the book (docs/wave7-plan.md step 7c.1). */
  @Get('projects/:id/mb-proposal')
  mbProposal(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })))
    q: { month: string },
  ) {
    return this.proposals.proposal(c, id, q.month);
  }

  @Post('projects/:id/mb-proposal')
  @HttpCode(200)
  @RequiresFeatures()
  acceptMbProposal(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          lines: z
            .array(
              z.object({
                boqId: z.uuid(),
                lineKey: z.uuid(),
                qty: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/),
              }),
            )
            .min(1)
            .max(5000),
        }),
      ),
    )
    b: { month: string; lines: { boqId: string; lineKey: string; qty: string }[] },
  ) {
    return this.proposals.accept(c, id, b.month, b.lines);
  }
}
