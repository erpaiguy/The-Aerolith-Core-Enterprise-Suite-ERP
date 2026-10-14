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
import { type ItpInput, ItpService } from './itp.service.js';

/** A project's inspection and test plan (docs/wave7-plan.md step 7d.4). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ItpController {
  constructor(private readonly itp: ItpService) {}

  @Get('projects/:id/itp')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.itp.list(c, id);
  }

  @Post('projects/:id/itp')
  @HttpCode(200)
  @RequiresFeatures()
  add(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(
        z.object({
          activity: z.string().trim().min(2).max(300),
          stage: z.enum(['before', 'during', 'after']).default('during'),
          checklistTemplateId: z.uuid().nullable().default(null),
          testKind: z.enum(['cube', 'slump', 'steel', 'soil', 'brick']).nullable().default(null),
          frequency: z.string().trim().max(200).default(''),
          holdPoint: z.boolean().default(false),
          responsible: z.string().trim().max(120).default(''),
        }),
      ),
    )
    b: ItpInput,
  ) {
    return this.itp.add(c, id, b);
  }

  @Delete('itp-lines/:id')
  @RequiresFeatures()
  remove(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.itp.remove(c, id);
  }
}
