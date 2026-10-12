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
import { ReviewService } from './review.service.js';

const reviewer = z.object({
  kind: z.enum(['user', 'lead', 'member', 'designation']),
  id: z.uuid().optional(),
});
const stage = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(['all', 'any']).default('all'),
  dueDays: z.number().int().min(0).max(90).default(7),
  reviewers: z.array(reviewer).min(1).max(20),
});
const workflow = z.object({
  id: z.uuid().nullable().default(null),
  projectId: z.uuid().nullable().default(null),
  name: z.string().trim().min(2).max(120),
  stages: z.array(stage).min(1).max(10),
  active: z.boolean().default(true),
});
const code = z.object({
  code: z.string().regex(/^[A-Z0-9]{1,4}$/, 'One to four capitals or digits'),
  label: z.string().trim().min(1).max(80),
  effect: z.enum(['approve', 'approve_comments', 'return', 'reject']),
  active: z.boolean().default(true),
});
const start = z.object({
  documentId: z.uuid(),
  versionNo: z.number().int().positive().nullable().default(null),
  workflowId: z.uuid(),
  title: z.string().trim().min(3).max(300),
});
const respond = z.object({
  code: z.string().min(1).max(4),
  comment: z.string().trim().max(4000).default(''),
});

/** Document review workflows (docs/wave5-plan.md step 1). Who may do what is checked by the service. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get('review-codes')
  codes(@Auth() c: TenantClaims) {
    return this.reviews.codes(c);
  }

  @Post('review-codes')
  @HttpCode(200)
  @RequiresFeatures()
  setCode(@Auth() c: TenantClaims, @Body(new ZodPipe(code)) b: z.infer<typeof code>) {
    return this.reviews.setCode(c, b);
  }

  @Get('review-workflows')
  workflows(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ projectId: z.uuid().optional() }))) q: { projectId?: string },
  ) {
    return this.reviews.workflows(c, q.projectId ?? null);
  }

  @Post('review-workflows')
  @HttpCode(200)
  @RequiresFeatures()
  saveWorkflow(@Auth() c: TenantClaims, @Body(new ZodPipe(workflow)) b: z.infer<typeof workflow>) {
    return this.reviews.saveWorkflow(c, b);
  }

  @Get('projects/:id/reviews')
  list(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.list(c, id);
  }

  @Post('projects/:id/reviews')
  @RequiresFeatures()
  start(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(start)) b: z.infer<typeof start>,
  ) {
    return this.reviews.start(c, id, b);
  }

  @Get('reviews/mine')
  mine(@Auth() c: TenantClaims) {
    return this.reviews.mine(c);
  }

  @Get('reviews/:id')
  get(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.get(c, id);
  }

  @Post('review-tasks/:id/respond')
  @HttpCode(200)
  @RequiresFeatures()
  respond(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(respond)) b: z.infer<typeof respond>,
  ) {
    return this.reviews.respond(c, id, b);
  }

  @Post('reviews/:id/withdraw')
  @HttpCode(200)
  @RequiresFeatures()
  withdraw(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.withdraw(c, id);
  }

  @Post('reviews/:id/resubmit')
  @HttpCode(200)
  @RequiresFeatures()
  resubmit(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      new ZodPipe(z.object({ versionNo: z.number().int().positive().nullable().default(null) })),
    )
    b: { versionNo: number | null },
  ) {
    return this.reviews.resubmit(c, id, b.versionNo);
  }
}
