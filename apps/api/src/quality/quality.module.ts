import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { QualityController } from './quality.controller.js';
import { QualityService } from './quality.service.js';

/** Quality (docs/wave3-plan.md step 14). */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, DocumentsModule],
  controllers: [QualityController],
  providers: [QualityService],
})
export class QualityModule {}
