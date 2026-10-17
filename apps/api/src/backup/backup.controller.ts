import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, Roles, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { BackupService } from './backup.service.js';

const settings = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  keep: z.number().int().min(1).max(90),
});
const asOf = z.object({ asOf: z.iso.date() });

function fileHeaders(reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, no-store');
}

/** Backups, the restore check and the audit export (docs/wave8-plan.md step 8g.2). Admins only. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
@Roles('admin')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('backups')
  overview(@Auth() c: TenantClaims) {
    return this.backups.overview(c);
  }

  @Post('backups/settings')
  @HttpCode(200)
  @RequiresFeatures()
  setSettings(@Auth() c: TenantClaims, @Body(new ZodPipe(settings)) b: z.infer<typeof settings>) {
    return this.backups.setSettings(c, b);
  }

  @Post('backups')
  @HttpCode(200)
  take(@Auth() c: TenantClaims) {
    return this.backups.takeNow(c);
  }

  @Post('backups/:id/check')
  @HttpCode(200)
  check(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.backups.checkNow(c, id);
  }

  @Get('backups/:id/file')
  async file(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.backups.download(c, id);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: 'application/gzip',
      disposition: attachment(f.fileName),
    });
  }

  @Get('audit-export')
  async auditExport(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(asOf)) q: z.infer<typeof asOf>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.backups.auditExport(c, q.asOf);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: 'application/zip',
      disposition: attachment(f.fileName),
    });
  }
}
