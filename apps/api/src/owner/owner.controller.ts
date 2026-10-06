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
import { OwnerGuard } from './owner.guard.js';

const ACTOR = 'owner';

const createTrialSchema = z.object({
  email: z.string().email().max(254),
  tenantName: z.string().trim().min(2).max(200),
});
const trialChangeSchema = z.object({
  newEndsAt: z.coerce.date(),
  reason: z.string().trim().max(500).default(''),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerController {
  constructor(private readonly licensing: LicensingService) {}

  @Post('tenants')
  createTrial(@Body(new ZodPipe(createTrialSchema)) body: z.infer<typeof createTrialSchema>) {
    return this.licensing.createTenantWithTrial(body.email, body.tenantName, ACTOR);
  }

  @Get('licences/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.licensing.getLicence(id);
  }

  @Post('licences/:id/trial-end')
  @HttpCode(200)
  changeTrialEnd(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(trialChangeSchema)) body: z.infer<typeof trialChangeSchema>,
  ) {
    return this.licensing.changeTrialEnd(id, body.newEndsAt, body.reason, ACTOR);
  }

  @Post('licences/:id/revoke')
  @HttpCode(200)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.licensing.revokeLicence(id, body.reason, ACTOR);
  }

  @Post('licences/:id/devices/:deviceId/revoke')
  @HttpCode(200)
  revokeDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ) {
    return this.licensing.revokeDevice(id, deviceId, ACTOR);
  }

  @Post('licences/:id/reveal-key')
  @HttpCode(200)
  async revealKey(@Param('id', ParseUUIDPipe) id: string) {
    return { licenceKey: await this.licensing.revealKey(id, ACTOR) };
  }
}
