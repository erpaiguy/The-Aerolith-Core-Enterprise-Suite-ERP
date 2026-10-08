import {
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
import { AllowWhilePasswordChangeRequired, Auth, OperatorGuard } from '../auth/guards.js';
import type { AccessClaims } from '../auth/tokens.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { OwnerConsoleService } from './owner-console.service.js';

type OperatorClaims = Extract<AccessClaims, { kind: 'operator' }>;

const tenantsQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/** Read models and small actions for the owner console screens (docs/owner-console.md). */
@Controller('owner')
@UseGuards(OperatorGuard)
export class OwnerConsoleController {
  constructor(
    private readonly console: OwnerConsoleService,
    private readonly licensing: LicensingService,
  ) {}

  @Get('me')
  @AllowWhilePasswordChangeRequired()
  me(@Auth() op: OperatorClaims) {
    return this.console.operator(op.sub);
  }

  @Get('overview')
  overview() {
    return this.console.overview();
  }

  @Get('tenants')
  tenants(@Query(new ZodPipe(tenantsQuery)) q: z.infer<typeof tenantsQuery>) {
    return this.console.tenants({ q: q.q, limit: q.limit });
  }

  @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.console.tenant(id);
  }

  @Get('audit')
  audit(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.console.audit(q);
  }

  @Get('migrations/runs')
  runs(@Query(new ZodPipe(runsQuery)) q: z.infer<typeof runsQuery>) {
    return this.console.migrationRuns(q.limit);
  }

  @Post('licences/:id/resend-key')
  @HttpCode(200)
  resendKey(@Auth() op: OperatorClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.licensing.resendKey(id, `operator:${op.sub}`);
  }
}
