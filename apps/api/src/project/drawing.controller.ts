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
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DrawingService } from './drawing.service.js';

const discipline = z.enum([
  'architectural',
  'structural',
  'electrical',
  'plumbing',
  'hvac',
  'fire',
  'landscape',
  'interiors',
  'other',
]);
const create = z.object({
  number: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  discipline,
});
const revision = z.object({
  revision: z.string().trim().min(1).max(20),
  purpose: z.enum(['information', 'approval', 'construction']),
  receivedFrom: z.string().trim().max(200).default(''),
  receivedOn: z.iso.date(),
  note: z.string().trim().max(2000).default(''),
});

/** A project's drawings register (docs/wave2b-plan.md step 8). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class DrawingController {
  constructor(
    private readonly drawings: DrawingService,
    private readonly docs: DocumentsService,
  ) {}

  @Get('projects/:id/drawings')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.drawings.list(c, id);
  }

  @Post('projects/:id/drawings')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(create)) b: z.infer<typeof create>,
  ) {
    return this.drawings.create(c, id, b);
  }

  @Get('drawings/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.drawings.get(c, id);
  }

  /** multipart/form-data, field `file`: the revision's drawing; its details in the query. */
  @Post('drawings/:id/revisions')
  @HttpCode(200)
  @RequiresFeatures()
  async addRevision(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(revision)) q: z.infer<typeof revision>,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the drawing as form data.',
      });
    const file = await req.file({
      limits: { fileSize: this.docs.maxBytes + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No drawing was sent.' });
    return this.drawings.addRevision(c, id, q, {
      name: file.filename,
      stream: file.file,
      truncated: () => file.file.truncated,
    });
  }
}
