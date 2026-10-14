import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';
import { SiteWalkController } from './site-walk.controller.js';
import { SiteWalkService } from './site-walk.service.js';

/** Safety (docs/wave3-plan.md step 15). */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [SafetyController, SiteWalkController],
  providers: [SafetyService, SiteWalkService],
})
export class SafetyModule {}
