import {
  Body,
  Controller,
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
import { PeopleChecklistService } from './checklist.service.js';

/** Joining and exit checklists (docs/wave7-plan.md step 7d.8). */
@Controller('tenant/hr')
@UseGuards(TenantAuthGuard)
export class PeopleChecklistController {
  constructor(private readonly checklists: PeopleChecklistService) {}

  @Get('employees/:id/checklists')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.get(c, id);
  }

  @Post('employees/:id/checklists')
  @HttpCode(200)
  @RequiresFeatures()
  start(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ kind: z.enum(['joining', 'exit']) })))
    b: { kind: 'joining' | 'exit' },
  ) {
    return this.checklists.start(c, id, b.kind);
  }

  @Post('checklist-steps/:id')
  @HttpCode(200)
  @RequiresFeatures()
  tick(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          done: z.boolean(),
          doneOn: z.iso
            .date()
            .default(() => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)),
          note: z.string().trim().max(500).default(''),
        }),
      ),
    )
    b: { done: boolean; doneOn: string; note: string },
  ) {
    return this.checklists.tick(c, id, b);
  }
}
