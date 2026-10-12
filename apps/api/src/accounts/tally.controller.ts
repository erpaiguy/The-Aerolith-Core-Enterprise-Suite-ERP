import { Body, Controller, Get, Put, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MODES, TallyService, type AccountsMode } from './tally.service.js';

const date = z.iso.date();
const file = (reply: FastifyReply, r: { fileName: string; xml: string }) => {
  reply.header('Cache-Control', 'private, no-store');
  return new StreamableFile(Buffer.from(r.xml, 'utf8'), {
    type: 'application/xml',
    disposition: attachment(r.fileName),
  });
};

/** The Tally export and the accounts mode (docs/wave3-plan.md step 8b). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class TallyController {
  constructor(private readonly tally: TallyService) {}

  @Get('accounts/mode')
  mode(@Auth() c: TenantClaims) {
    return this.tally.getMode(c);
  }

  @Put('accounts/mode')
  @RequiresFeatures()
  setMode(
    @Auth() c: TenantClaims,
    @Body(new ZodPipe(z.object({ mode: z.enum(MODES) }))) b: { mode: AccountsMode },
  ) {
    return this.tally.setMode(c, b.mode);
  }

  @Get('accounts/tally/masters')
  async masters(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date })))
    q: { entityId: string; from: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return file(reply, await this.tally.masters(c, q));
  }

  @Get('accounts/tally/vouchers')
  async vouchers(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ entityId: z.uuid(), from: date, to: date })))
    q: { entityId: string; from: string; to: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return file(reply, await this.tally.vouchers(c, q));
  }
}
