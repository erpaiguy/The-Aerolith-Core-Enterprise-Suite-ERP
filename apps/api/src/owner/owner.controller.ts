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
import { ZodPipe } from '../common/zod.pipe.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { MigrationOrchestrator } from '../provisioning/orchestrator.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { Auth, OperatorGuard } from '../auth/guards.js';
import type { AccessClaims } from '../auth/tokens.js';

type OperatorClaims = Extract<AccessClaims, { kind: 'operator' }>;
const actor = (op: OperatorClaims) => `operator:${op.sub}`;

const createTrialSchema = z.object({
  email: z.string().email().max(254),
  tenantName: z.string().trim().min(2).max(200),
});
const trialChangeSchema = z.object({
  newEndsAt: z.coerce.date(),
  reason: z.string().trim().max(500).default(''),
});
const portalCapSchema = z.object({
  portalCap: z.number().int().min(0).max(100000),
  reason: z.string().trim().min(3).max(500),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const provisionSchema = z.object({ provider: z.enum(['local_postgres']) });
const rolloutSchema = z.object({
  concurrency: z.number().int().min(1).max(32).default(4),
  failureThreshold: z.number().int().min(1).max(1000).default(3),
});

@Controller('owner')
@UseGuards(OperatorGuard)
export class OwnerController {
  constructor(
    private readonly licensing: LicensingService,
    private readonly provisioning: ProvisioningService,
    private readonly onboarding: OnboardingService,
    private readonly orchestrator: MigrationOrchestrator,
  ) {}

  /** Stand-in provider (local Postgres). Supabase tenants are provisioned through the onboarding link instead. */
  @Post('tenants/:id/provision')
  provision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(provisionSchema)) body: z.infer<typeof provisionSchema>,
  ) {
    return this.provisioning.register(id, body.provider);
  }

  @Post('tenants/:id/onboarding-link')
  onboardingLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.onboarding.createLink(id);
  }

  @Get('tenants/:id/database')
  database(@Param('id', ParseUUIDPipe) id: string) {
    return this.provisioning.status(id);
  }

  @Post('migrations/rollout')
  @HttpCode(200)
  rollout(@Body(new ZodPipe(rolloutSchema)) body: z.infer<typeof rolloutSchema>) {
    return this.orchestrator.rollout(body);
  }

  @Post('tenants')
  createTrial(
    @Auth() op: OperatorClaims,
    @Body(new ZodPipe(createTrialSchema)) body: z.infer<typeof createTrialSchema>,
  ) {
    return this.licensing.createTenantWithTrial(body.email, body.tenantName, actor(op));
  }

  @Get('licences/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.licensing.getLicence(id);
  }

  @Post('licences/:id/trial-end')
  @HttpCode(200)
  changeTrialEnd(
    @Auth() op: OperatorClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(trialChangeSchema)) body: z.infer<typeof trialChangeSchema>,
  ) {
    return this.licensing.changeTrialEnd(id, body.newEndsAt, body.reason, actor(op));
  }

  @Post('licences/:id/portal-cap')
  @HttpCode(200)
  changePortalCap(
    @Auth() op: OperatorClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(portalCapSchema)) body: z.infer<typeof portalCapSchema>,
  ) {
    return this.licensing.changePortalCap(id, body.portalCap, body.reason, actor(op));
  }

  @Post('licences/:id/revoke')
  @HttpCode(200)
  revoke(
    @Auth() op: OperatorClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.licensing.revokeLicence(id, body.reason, actor(op));
  }

  @Post('licences/:id/devices/:deviceId/revoke')
  @HttpCode(200)
  revokeDevice(
    @Auth() op: OperatorClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ) {
    return this.licensing.revokeDevice(id, deviceId, actor(op));
  }

  @Post('licences/:id/reveal-key')
  @HttpCode(200)
  async revealKey(@Auth() op: OperatorClaims, @Param('id', ParseUUIDPipe) id: string) {
    return { licenceKey: await this.licensing.revealKey(id, actor(op)) };
  }
}
