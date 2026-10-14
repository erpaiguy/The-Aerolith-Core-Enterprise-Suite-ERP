import {
  BadRequestException,
  Controller,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, Roles, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { IMPORT_KINDS, type ImportKind, ImportsService } from './imports.service.js';

/** Bulk imports from Excel, by the admin (docs/wave7-plan.md step 7c.8). `apply=false` only checks. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('imports/:kind')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  async run(
    @Auth() c: TenantClaims,
    @Param('kind', new ZodPipe(z.enum(IMPORT_KINDS))) kind: ImportKind,
    @Query(
      new ZodPipe(
        z.object({
          apply: z.enum(['true', 'false']).default('false'),
          entityId: z.uuid().optional(),
        }),
      ),
    )
    q: { apply: 'true' | 'false'; entityId?: string },
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the workbook as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No workbook was sent.' });
    const read = await this.imports.read(kind, await file.toBuffer());
    if (q.apply === 'false')
      return {
        ...read,
        saved: 0,
        failed: read.rows.filter((r) => r.problem).length,
        applied: false,
      };
    return {
      columns: read.columns,
      ...(await this.imports.apply(c, kind, q.entityId ?? null, read.rows)),
      applied: true,
    };
  }
}
