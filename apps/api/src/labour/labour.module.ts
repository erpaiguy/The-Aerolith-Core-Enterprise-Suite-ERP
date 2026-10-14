import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { LabourController } from './labour.controller.js';
import { LabourService } from './labour.service.js';

/** Contract labour (docs/wave3-plan.md step 13). */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, AccountsModule],
  controllers: [LabourController],
  providers: [LabourService],
  exports: [LabourService],
})
export class LabourModule {}
