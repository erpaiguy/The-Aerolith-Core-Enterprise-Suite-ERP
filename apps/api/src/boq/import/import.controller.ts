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
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../../auth/permissions.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { FIELDS, STRUCTURES, type Field, type Mapping } from './builder.js';
import { ExportService } from './export.service.js';
import { ImportService } from './import.service.js';

const column = z.number().int().min(0).max(99);
const settingsBody = z.object({
  sheet: z.number().int().min(0).max(49),
  headerRow: z.number().int().min(1).nullable(),
  mapping: z
    .object(
      Object.fromEntries(FIELDS.map((f) => [f, column.optional()])) as Record<
        Field,
        z.ZodOptional<typeof column>
      >,
    )
    .strict()
    .refine(
      (m) => {
        const cols = Object.values(m).filter((v) => v !== undefined);
        return new Set(cols).size === cols.length;
      },
      { message: 'Each column can be used for one field only' },
    ),
  structure: z.enum(STRUCTURES),
  normaliseUnits: z.boolean().default(true),
});
const startBody = z.object({ skipErrors: z.boolean().default(false) });
const exportQuery = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  /** Adds quoted rates loaded with this pricing scenario's markups (current version only). */
  scenario: z.uuid().optional(),
  /** An earlier, frozen version of the BOQ. */
  version: z.coerce.number().int().min(1).optional(),
  /** Rates and amounts left blank: the BOQ to send to subcontractors or to fill in again. */
  unpriced: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
const unitText = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[\p{L}\p{N} ./%²³-]+$/u, 'Letters, digits, spaces and . / % - only');
const unitBody = z.object({
  code: unitText,
  name: z.string().trim().min(1).max(60),
  aliases: z.array(unitText).max(20).default([]),
});

export const attachment = (fileName: string) =>
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

/**
 * BOQ import and export, and the units list (docs/wave1-plan.md step 4). Importing needs `boq.edit`; exporting is
 * reading, so everyone signed in can export, even on a read-only licence.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly exports: ExportService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('units')
  units(@Auth() c: TenantClaims) {
    return this.imports.units(c);
  }

  @Post('units')
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  addUnit(@Auth() c: TenantClaims, @Body(new ZodPipe(unitBody)) b: z.infer<typeof unitBody>) {
    return this.imports.addUnit(c, b);
  }

  /** multipart/form-data with one file field. */
  @Post('boqs/:id/imports')
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  async upload(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) boqId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    const file = await req.file({ limits: { fileSize: this.config.importMaxBytes, files: 1 } });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    return this.imports.upload(c, boqId, {
      filename: file.filename,
      stream: file.file,
      truncated: () => file.file.truncated,
    });
  }

  @Get('boqs/:id/imports/latest')
  @RequiresPermission('boq.edit')
  async latest(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) boqId: string) {
    return { job: await this.imports.latest(c, boqId) };
  }

  @Get('imports/:id')
  @RequiresPermission('boq.edit')
  job(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(c, id);
  }

  @Post('imports/:id/validate')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  validate(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(settingsBody)) b: z.infer<typeof settingsBody>,
  ) {
    const mapping = Object.fromEntries(
      Object.entries(b.mapping).filter(([, v]) => v !== undefined),
    ) as Mapping;
    return this.imports.validate(c, id, { ...b, mapping });
  }

  @Get('imports/:id/issues')
  @RequiresPermission('boq.edit')
  async issues(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.imports.issuesReport(c, id), {
      type: 'text/csv; charset=utf-8',
      disposition: attachment('import-issues.csv'),
    });
  }

  @Post('imports/:id/start')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  @RequiresFeatures()
  start(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(startBody)) b: z.infer<typeof startBody>,
  ) {
    return this.imports.start(c, id, b.skipErrors);
  }

  @Post('imports/:id/cancel')
  @HttpCode(200)
  @RequiresPermission('boq.edit')
  cancel(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.cancel(c, id);
  }

  @Get('boqs/:id/export')
  async export(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) boqId: string,
    @Query(new ZodPipe(exportQuery)) q: z.infer<typeof exportQuery>,
  ) {
    const out = await this.exports.export(c, boqId, q.format, q.scenario, q.version, q.unpriced);
    return new StreamableFile(out.stream, {
      type: out.contentType,
      disposition: attachment(out.fileName),
    });
  }
}
