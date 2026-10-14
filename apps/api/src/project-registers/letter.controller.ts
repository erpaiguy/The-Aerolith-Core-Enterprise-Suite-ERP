import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { type LetterInput, LetterService } from './letter.service.js';

/** A project's correspondence register (docs/wave7-plan.md step 7d.2). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class LetterController {
  constructor(private readonly letters: LetterService) {}

  @Get('projects/:id/letters')
  list(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ direction: z.enum(['in', 'out']).optional() })))
    q: { direction?: 'in' | 'out' },
  ) {
    return this.letters.list(c, id, q.direction);
  }

  @Post('projects/:id/letters')
  @HttpCode(200)
  @RequiresFeatures()
  create(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          direction: z.enum(['in', 'out']),
          letterDate: z.iso.date(),
          party: z.string().trim().min(2).max(200),
          reference: z.string().trim().max(100).default(''),
          subject: z.string().trim().min(3).max(300),
          summary: z.string().trim().max(4000).default(''),
          replyTo: z.uuid().nullable().default(null),
          replyBy: z.iso.date().nullable().default(null),
          documentId: z.uuid().nullable().default(null),
        }),
      ),
    )
    b: LetterInput,
  ) {
    return this.letters.create(c, id, b);
  }

  @Post('letters/:id/close')
  @HttpCode(200)
  @RequiresFeatures()
  close(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.letters.close(c, id);
  }
}
