import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, Roles, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { type AuditQuery, AuditService } from './audit.service.js';

/** The audit trail, for the admin (docs/wave7-plan.md step 7a.8). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  @Roles('admin')
  list(
    @Auth() c: TenantClaims,
    @Query(
      new ZodPipe(
        z.object({
          userId: z.uuid().optional(),
          entity: z
            .string()
            .regex(/^[a-z_]+(\.[a-z_]+)?$/)
            .max(80)
            .optional(),
          entityId: z.string().trim().min(1).max(80).optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          before: z.coerce.number().int().positive().optional(),
        }),
      ),
    )
    q: AuditQuery,
  ) {
    return this.audit.list(c, q);
  }
}
