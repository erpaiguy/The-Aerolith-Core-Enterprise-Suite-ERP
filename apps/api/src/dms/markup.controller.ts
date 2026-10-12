import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarkupService } from './markup.service.js';

const frac = z.number().min(0).max(1);
const add = z.object({
  reviewId: z.uuid().nullable().default(null),
  page: z.number().int().min(0).max(100_000),
  box: z.object({ x: frac, y: frac, w: frac, h: frac }).nullable().default(null),
  body: z.string().trim().min(1).max(4000),
});
const reply = z.object({ body: z.string().trim().min(1).max(4000) });
const status = z.object({ status: z.enum(['open', 'resolved']) });

/** Mark-up and comments on a project document's version (docs/wave5-plan.md step 2). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class MarkupController {
  constructor(private readonly markups: MarkupService) {}

  @Get('documents/:id/versions/:version/markups')
  list(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.markups.list(c, id, version);
  }

  @Post('documents/:id/versions/:version/markups')
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodPipe(add)) b: z.infer<typeof add>,
  ) {
    return this.markups.add(c, id, version, b);
  }

  @Post('markups/:id/replies')
  @RequiresFeatures()
  reply(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reply)) b: z.infer<typeof reply>,
  ) {
    return this.markups.reply(c, id, b.body);
  }

  @Post('markups/:id/status')
  @HttpCode(200)
  @RequiresFeatures()
  setStatus(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(status)) b: z.infer<typeof status>,
  ) {
    return this.markups.setStatus(c, id, b.status);
  }

  @Get('reviews/:id/comments')
  async comments(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.markups.forReview(c, id)).comments;
  }

  /** The review's comment sheet as Excel. */
  @Get('reviews/:id/comment-sheet')
  async sheet(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const s = await this.markups.sheet(c, id);
    reply.header('Cache-Control', 'private, no-store');
    return new StreamableFile(s.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: attachment(s.fileName),
    });
  }
}
