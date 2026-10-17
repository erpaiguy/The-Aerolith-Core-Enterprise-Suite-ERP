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
import { Auth, RequiresFeatures, Roles, TenantAuthGuard } from '../auth/guards.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApprovalService } from './approval.service.js';

const money = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), { message: 'An amount in rupees' });
const rules = z.object({
  rules: z
    .array(
      z
        .object({
          minAmount: money,
          approver: z.enum([
            'project_lead',
            'manager',
            'admin',
            'user',
            'designation',
            'reporting_manager',
          ]),
          userId: z.uuid().nullable().default(null),
          designationId: z.uuid().nullable().default(null),
          label: z.string().trim().max(100).default(''),
        })
        .refine((r) => (r.approver === 'user') === (r.userId !== null), {
          message: 'Name the person for a named approver (and only then)',
        })
        .refine((r) => (r.approver === 'designation') === (r.designationId !== null), {
          message: 'Name the designation for a designation approver (and only then)',
        }),
    )
    .max(6),
});
const view = z.object({ view: z.enum(['waiting', 'mine', 'decided']).default('waiting') });
const note = z.object({ comment: z.string().trim().max(2000).optional() });
const reason = z.object({ comment: z.string().trim().min(3).max(2000) });
const date = z.iso.date();
const delegation = z.object({
  fromUserId: z.uuid().nullable().default(null),
  toUserId: z.uuid(),
  startsOn: date,
  endsOn: date,
  reason: z.string().trim().max(300).default(''),
});

/**
 * Approvals (docs/wave2b-plan.md step 1): the rules (the admin), requests waiting on me or mine, approving,
 * rejecting, withdrawing, comments, and standing in for someone while they are away.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get('approval-rules')
  rules(@Auth() c: TenantClaims) {
    return this.approvals.rules(c);
  }

  @Post('approval-rules/:docType')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  setRules(
    @Auth() c: TenantClaims,
    @Param('docType') docType: string,
    @Body(new ZodPipe(rules)) b: z.infer<typeof rules>,
  ) {
    return this.approvals.setRules(c, docType, b.rules);
  }

  @Get('approvals')
  list(@Auth() c: TenantClaims, @Query(new ZodPipe(view)) q: z.infer<typeof view>) {
    return this.approvals.list(c, q.view);
  }

  @Get('approvals/:id')
  detail(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.detail(c, id);
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  @RequiresFeatures()
  approve(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(note)) b: z.infer<typeof note>,
  ) {
    return this.approvals.approve(c, id, b.comment || null);
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  @RequiresFeatures()
  reject(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: z.infer<typeof reason>,
  ) {
    return this.approvals.reject(c, id, b.comment);
  }

  @Post('approvals/:id/withdraw')
  @HttpCode(200)
  @RequiresFeatures()
  withdraw(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(note)) b: z.infer<typeof note>,
  ) {
    return this.approvals.withdraw(c, id, b.comment || null);
  }

  @Post('approvals/:id/comments')
  @HttpCode(200)
  @RequiresFeatures()
  comment(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reason)) b: z.infer<typeof reason>,
  ) {
    return this.approvals.comment(c, id, b.comment);
  }

  @Get('approval-delegations')
  delegations(@Auth() c: TenantClaims) {
    return this.approvals.delegations(c);
  }

  @Post('approval-delegations')
  @HttpCode(200)
  @RequiresFeatures()
  delegate(@Auth() c: TenantClaims, @Body(new ZodPipe(delegation)) b: z.infer<typeof delegation>) {
    return this.approvals.delegate(c, b);
  }

  @Post('approval-delegations/:id/cancel')
  @HttpCode(200)
  @RequiresFeatures()
  cancel(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.cancelDelegation(c, id);
  }
}
