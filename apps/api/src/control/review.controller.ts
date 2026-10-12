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
import { MepService, SYSTEMS } from './mep.service.js';
import { ReviewService } from './review.service.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM');
const equipment = z.object({
  tag: z.string().trim().min(1).max(60),
  system: z.enum(SYSTEMS),
  description: z.string().trim().min(2).max(500),
  capacity: z.string().trim().max(100).default(''),
  location: z.string().trim().max(200).default(''),
  make: z.string().trim().max(200).default(''),
});
const status = z.object({
  status: z.enum(['planned', 'ordered', 'delivered', 'installed', 'tested', 'commissioned']),
  checklistId: z.uuid().nullable().default(null),
  rowVersion: z.number().int().positive(),
});
const issue = z.object({
  systems: z.array(z.enum(SYSTEMS)).min(1).max(5),
  location: z.string().trim().max(200).default(''),
  drawingRef: z.string().trim().max(200).default(''),
  description: z.string().trim().min(3).max(2000),
  raisedOn: z.iso.date(),
});
const resolve = z.object({ resolution: z.string().trim().min(3).max(2000), on: z.iso.date() });

/** The portfolio, a project's monthly review and the MEP pack (docs/wave4-plan.md step 7). */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly mep: MepService,
  ) {}

  @Get('portfolio')
  portfolio(
    @Auth() c: TenantClaims,
    @Query(new ZodPipe(z.object({ asOf: z.iso.date().optional() }))) q: { asOf?: string },
  ) {
    return this.review.portfolio(c, q.asOf);
  }

  @Get('projects/:id/review')
  monthly(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(z.object({ month }))) q: { month: string },
  ) {
    return this.review.review(c, id, q.month);
  }

  @Post('mep-pack')
  @HttpCode(200)
  @RequiresFeatures()
  loadPack(@Auth() c: TenantClaims) {
    return this.mep.loadPack(c);
  }

  @Get('projects/:id/mep')
  mepRegister(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.mep.register(c, id);
  }

  @Post('projects/:id/mep/equipment')
  @HttpCode(200)
  @RequiresFeatures()
  addEquipment(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(equipment)) b: z.infer<typeof equipment>,
  ) {
    return this.mep.addEquipment(c, id, b);
  }

  @Post('mep-equipment/:id/status')
  @HttpCode(200)
  @RequiresFeatures()
  setStatus(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(status)) b: z.infer<typeof status>,
  ) {
    return this.mep.setStatus(c, id, b);
  }

  @Post('projects/:id/mep/issues')
  @HttpCode(200)
  @RequiresFeatures()
  raise(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(issue)) b: z.infer<typeof issue>,
  ) {
    return this.mep.raiseIssue(c, id, b);
  }

  @Post('coordination-issues/:id/resolve')
  @HttpCode(200)
  @RequiresFeatures()
  resolveIssue(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolve)) b: z.infer<typeof resolve>,
  ) {
    return this.mep.resolveIssue(c, id, b);
  }
}
