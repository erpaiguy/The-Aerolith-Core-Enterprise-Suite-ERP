import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BiModule } from '../bi/bi.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ApiKeysService } from './api-keys.service.js';
import {
  ApiKeyGuard,
  IntegrationsController,
  PublicApiController,
} from './integrations.controller.js';
import { WebhooksService } from './webhooks.service.js';

/** The public API, webhooks and the Tally agent's endpoints (docs/wave6-plan.md step 6). */
@Module({
  imports: [ProvisioningModule, AuthModule, LicensingModule, BiModule, AccountsModule],
  controllers: [PublicApiController, IntegrationsController],
  providers: [ApiKeysService, ApiKeyGuard, WebhooksService],
})
export class IntegrationsModule {}
