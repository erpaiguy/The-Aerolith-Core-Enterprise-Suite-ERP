import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { type LetterheadInput, LetterheadService } from './letterhead.service.js';

const line = (max: number) => z.string().trim().max(max).default('');

/** Each company's letterhead for printed documents (docs/wave7-plan.md step 7b.1). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class LetterheadController {
  constructor(private readonly letterhead: LetterheadService) {}

  @Get('companies/:id/letterhead')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.letterhead.get(c, id);
  }

  @Post('companies/:id/letterhead')
  @HttpCode(200)
  @RequiresFeatures()
  set(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          phone: line(60),
          email: z.union([z.literal(''), z.email().max(120)]).default(''),
          website: line(120),
          footer: line(500),
          signatoryName: line(120),
          signatoryTitle: line(120),
        }),
      ),
    )
    b: LetterheadInput,
  ) {
    return this.letterhead.set(c, id, b);
  }

  @Post('companies/:id/logo')
  @HttpCode(200)
  @RequiresFeatures()
  setLogo(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ dataUrl: z.string().max(450_000) }))) b: { dataUrl: string },
  ) {
    return this.letterhead.setLogo(c, id, b.dataUrl);
  }

  @Delete('companies/:id/logo')
  @RequiresFeatures()
  removeLogo(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.letterhead.removeLogo(c, id);
  }
}
