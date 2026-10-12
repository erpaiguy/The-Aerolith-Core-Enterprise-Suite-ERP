import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SignoffService, type Who } from './signoff.service.js';

const frac = z.number().min(0).max(1);
// A 200 KB PNG is about 274 KB of base64.
const png = z.string().min(100).max(280_000);
const start = z.object({
  title: z.string().trim().min(3).max(300),
  documentId: z.uuid(),
  versionNo: z.number().int().positive().nullable().default(null),
  reviewId: z.uuid().nullable().default(null),
  signers: z
    .array(
      z.object({
        userId: z.uuid(),
        page: z.number().int().min(1).max(100_000),
        box: z.object({ x: frac, y: frac, w: frac.positive(), h: frac.positive() }),
      }),
    )
    .min(1)
    .max(10),
});

const who = (req: FastifyRequest): Who => ({
  ip: req.ip ?? null,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
});

/** Internal sign-off with drawn signatures (docs/wave5-plan.md step 5). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class SignoffController {
  constructor(private readonly signoffs: SignoffService) {}

  @Get('my-signature')
  mySignature(@Auth() c: TenantClaims) {
    return this.signoffs.mySignature(c);
  }

  @Post('my-signature')
  @HttpCode(200)
  @RequiresFeatures()
  saveSignature(@Auth() c: TenantClaims, @Body(new ZodPipe(z.object({ png }))) b: { png: string }) {
    return this.signoffs.saveSignature(c, b.png);
  }

  @Get('projects/:id/sign-offs')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.signoffs.list(c, id);
  }

  @Post('projects/:id/sign-offs')
  @RequiresFeatures()
  start(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(start)) b: z.infer<typeof start>,
  ) {
    return this.signoffs.start(c, id, b);
  }

  @Get('sign-offs/mine')
  mine(@Auth() c: TenantClaims) {
    return this.signoffs.mine(c);
  }

  @Get('sign-offs/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.signoffs.get(c, id);
  }

  /** Sign on my turn: `png` is a new drawing, or null for my saved signature. */
  @Post('sign-offs/:id/sign')
  @HttpCode(200)
  @RequiresFeatures()
  sign(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ png: png.nullable().default(null) }))) b: { png: string | null },
    @Req() req: FastifyRequest,
  ) {
    return this.signoffs.sign(c, id, b, who(req));
  }

  @Post('sign-offs/:id/decline')
  @HttpCode(200)
  @RequiresFeatures()
  decline(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(1000) })))
    b: { reason: string },
    @Req() req: FastifyRequest,
  ) {
    return this.signoffs.decline(c, id, b.reason, who(req));
  }

  @Get('sign-offs/:id/verify')
  verify(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.signoffs.verify(c, id);
  }
}
