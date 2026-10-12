import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { CostControlController } from './cost-control.controller.js';
import { CostControlService } from './cost-control.service.js';

/** Control (docs/wave4-plan.md): cost control. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [CostControlController],
  providers: [CostControlService],
})
export class ControlModule {}
