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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { Idempotent } from '../common/idempotency.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DailyReportService } from './daily-report.service.js';

const date = z.iso.date();
const hours = (max: number) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d{1,4}(\.\d)?$/.test(v) && Number(v) <= max, {
      message: `Hours, one decimal, at most ${max}`,
    });
const weather = z.enum(['clear', 'cloudy', 'rain', 'heavy_rain', 'storm']).nullable().default(null);
const report = z.object({
  rowVersion: z.number().int().positive(),
  weatherAm: weather,
  weatherPm: weather,
  rainHours: hours(24).nullable().default(null),
  safety: z.string().trim().max(4000).default(''),
  visitors: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(8000).default(''),
  manpower: z
    .array(
      z.object({
        trade: z.string().trim().min(1).max(100),
        partyId: z.uuid().nullable().default(null),
        headcount: z.number().int().min(1).max(10000),
        note: z.string().trim().max(500).default(''),
      }),
    )
    .max(200)
    .default([]),
  equipment: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        ownership: z.enum(['own', 'hired']),
        count: z.number().int().min(1).max(1000).default(1),
        hoursWorked: hours(24000).default('0'),
        hoursIdle: hours(24000).default('0'),
        idleReason: z.string().trim().max(500).default(''),
      }),
    )
    .max(200)
    .default([]),
  work: z
    .array(
      z.object({
        boqCode: z
          .string()
          .trim()
          .max(40)
          .transform((v) => v || null)
          .nullable()
          .default(null),
        description: z.string().trim().min(1).max(1000),
        qty: z
          .union([z.string().trim(), z.number()])
          .transform((v) => (v === '' ? null : String(v)))
          .refine((v) => v === null || /^\d{1,14}(\.\d{1,4})?$/.test(v), {
            message: 'A number with up to 4 decimals',
          })
          .nullable()
          .default(null),
        unit: z.string().trim().max(20).default(''),
      }),
    )
    .max(500)
    .default([]),
  hindrances: z
    .array(
      z.object({
        cause: z.enum([
          'rain',
          'drawings',
          'client_decision',
          'materials',
          'labour',
          'equipment',
          'power_water',
          'site_access',
          'other',
        ]),
        description: z.string().trim().min(1).max(1000),
        hours: hours(24).refine((v) => Number(v) > 0, { message: 'More than nothing' }),
        account: z.enum(['client', 'contractor', 'neutral']),
      }),
    )
    .max(100)
    .default([]),
});
const create = z.object({ siteId: z.uuid(), reportDate: date });
const rowVersion = z.object({ rowVersion: z.number().int().positive() });
const acknowledge = z.object({
  comment: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || null)
    .nullable()
    .default(null),
});
const correct = z.object({ reason: z.string().trim().min(3).max(2000) });
const list = z.object({ siteId: z.uuid().optional() });
const summary = z.object({ from: date, to: date });
// When and where the photo was taken (step 8d.4); a position comes with both coordinates or neither.
const photoMeta = z
  .object({
    caption: z.string().trim().max(300).default(''),
    takenAt: z.iso.datetime({ offset: true }).nullable().default(null),
    latitude: z.coerce.number().min(-90).max(90).nullable().default(null),
    longitude: z.coerce.number().min(-180).max(180).nullable().default(null),
    accuracyM: z.coerce.number().int().min(0).max(100_000).nullable().default(null),
  })
  .refine((m) => (m.latitude === null) === (m.longitude === null), {
    message: 'Give both coordinates or neither',
  });
const photoQuery = photoMeta;
const photoInline = photoMeta.and(z.object({ photo: z.string().max(900_000) }));

/** Daily site reports (docs/wave2b-plan.md step 7). Kept to each project's team by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class DailyReportController {
  constructor(private readonly reports: DailyReportService) {}

  @Get('projects/:id/daily-reports')
  list(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(list)) q: z.infer<typeof list>,
  ) {
    return this.reports.list(c, id, q);
  }

  @Get('projects/:id/daily-reports/summary')
  summary(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(summary)) q: z.infer<typeof summary>,
  ) {
    return this.reports.summary(c, id, q);
  }

  @Post('projects/:id/daily-reports')
  @Idempotent()
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    return this.reports.create(c, id, b);
  }

  @Get('daily-reports/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(c, id);
  }

  @Post('daily-reports/:id')
  @Idempotent()
  @HttpCode(200)
  @RequiresFeatures()
  update(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(report)) b: z.infer<typeof report>,
  ) {
    const { rowVersion: v, ...input } = b;
    return this.reports.update(c, id, v, input);
  }

  @Post('daily-reports/:id/submit')
  @HttpCode(200)
  @RequiresFeatures()
  submit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rowVersion)) b: z.infer<typeof rowVersion>,
  ) {
    return this.reports.submit(c, id, b.rowVersion);
  }

  @Post('daily-reports/:id/acknowledge')
  @HttpCode(200)
  @RequiresFeatures()
  acknowledge(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(acknowledge)) b: z.infer<typeof acknowledge>,
  ) {
    return this.reports.acknowledge(c, id, b.comment);
  }

  @Post('daily-reports/:id/correct')
  @HttpCode(200)
  @RequiresFeatures()
  correct(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(correct)) b: z.infer<typeof correct>,
  ) {
    return this.reports.correct(c, id, b.reason);
  }

  /** multipart/form-data, field `file`: one photo (the app shrinks it first). */
  @Post('daily-reports/:id/photos')
  @HttpCode(200)
  @RequiresFeatures()
  async addPhoto(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(photoQuery)) q: z.infer<typeof photoQuery>,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the photo as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 8 * 1024 * 1024 + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No photo was sent.' });
    return this.reports.addPhoto(c, id, q, {
      stream: file.file,
      truncated: () => file.file.truncated,
    });
  }

  /** The same photo in JSON (a data URL of at most 600 KB), so the app's outbox can keep it with no signal. */
  @Post('daily-reports/:id/photos/inline')
  @Idempotent()
  @HttpCode(200)
  @RequiresFeatures()
  addPhotoInline(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(photoInline)) b: z.infer<typeof photoInline>,
  ) {
    return this.reports.addPhotoInline(c, id, b);
  }

  @Get('daily-reports/:id/photos/:photoId')
  async photo(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.reports.photo(c, id, photoId);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(p.stream, { type: p.mime, length: p.size });
  }

  @Post('daily-reports/:id/photos/:photoId/remove')
  @HttpCode(200)
  @RequiresFeatures()
  removePhoto(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ) {
    return this.reports.removePhoto(c, id, photoId);
  }
}
