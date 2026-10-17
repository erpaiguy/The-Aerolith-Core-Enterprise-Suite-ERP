import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { HandoverController } from './handover.controller.js';
import { HandoverService } from './handover.service.js';
import { QualityController } from './quality.controller.js';
import { QualityService } from './quality.service.js';

/** Quality (docs/wave3-plan.md step 14). */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, DocumentsModule, AccountsModule],
  controllers: [QualityController, HandoverController],
  providers: [QualityService, HandoverService],
})
export class QualityModule {}
