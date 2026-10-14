import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  REGISTERS,
  type Register,
  type RegisterQuery,
  RegistersService,
} from './registers.service.js';

/** Company-wide registers of project records (docs/wave7-plan.md step 7a.3). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  @Get('registers/:kind')
  list(
    @Auth() c: TenantClaims,
    @Param('kind', new ZodPipe(z.enum(REGISTERS))) kind: Register,
    @Query(
      new ZodPipe(
        z.object({
          projectId: z.uuid().optional(),
          status: z.string().trim().min(1).max(40).optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
      ),
    )
    q: RegisterQuery,
  ) {
    return this.registers.list(c, kind, q);
  }
}
