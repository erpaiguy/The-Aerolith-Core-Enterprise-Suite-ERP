import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { CrmController } from './crm.controller.js';
import { CrmService } from './crm.service.js';

/** The CRM (docs/wave6-plan.md step 1). */
@Module({
  imports: [ProvisioningModule, AuthModule, TenderModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
