import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { RateLimit } from '../auth/rate-limit.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { RevisionService } from './revision.service.js';

const DISCIPLINES = [
  'architectural',
  'structural',
  'electrical',
  'plumbing',
  'hvac',
  'fire',
  'landscape',
  'interiors',
  'other',
] as const;
const rule = z.object({
  enabled: z.boolean(),
  construction: z.enum(['numbers', 'letters', 'r_numbers']).default('numbers'),
});
const row = z.object({
  discipline: z.enum(DISCIPLINES).nullable().default(null),
  userId: z.uuid().nullable().default(null),
  partyId: z.uuid().nullable().default(null),
  name: z.string().trim().min(2).max(200).nullable().default(null),
  email: z.email().max(254).nullable().default(null),
  everyPurpose: z.boolean().default(false),
});

/** Controlled revisions (docs/wave5-plan.md step 4): the series, the matrix, receipts and controlled copies. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class RevisionController {
  constructor(private readonly revisions: RevisionService) {}

  @Get('projects/:id/revision-control')
  settings(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisions.settings(c, id);
  }

  @Post('projects/:id/revision-rule')
  @HttpCode(200)
  @RequiresFeatures()
  setRule(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(rule)) b: z.infer<typeof rule>,
  ) {
    return this.revisions.setRule(c, id, b);
  }

  @Post('projects/:id/distribution')
  @HttpCode(200)
  @RequiresFeatures()
  addRow(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(row)) b: z.infer<typeof row>,
  ) {
    return this.revisions.addDistribution(c, id, b);
  }

  @Post('distribution/:id/delete')
  @HttpCode(200)
  @RequiresFeatures()
  removeRow(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisions.removeDistribution(c, id);
  }

  @Get('drawing-receipts')
  receipts(@Auth() c: TenantClaims) {
    return this.revisions.receipts(c);
  }

  @Post('drawing-receipts/:id/acknowledge')
  @HttpCode(200)
  @RequiresFeatures()
  acknowledge(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisions.acknowledge(c, id);
  }

  /** The controlled copy: the revision's PDF stamped on every page, with the QR to check it. */
  @Get('drawing-revisions/:id/print')
  async print(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.revisions.print(c, id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(p.bytes, {
      type: 'application/pdf',
      disposition: attachment(p.fileName),
    });
  }
}

/** The QR on a controlled copy: current or superseded, to anyone holding the print. */
@Controller('check')
@RateLimit(60)
export class CheckController {
  constructor(private readonly revisions: RevisionService) {}

  @Get(':tenant/:code')
  check(
    @Param('tenant', ParseUUIDPipe) tenant: string,
    @Param('code', ParseUUIDPipe) code: string,
  ) {
    return this.revisions.check(tenant, code);
  }
}
