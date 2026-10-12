import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { CashFlowController } from './cash-flow.controller.js';
import { CashFlowService } from './cash-flow.service.js';
import { CostControlController } from './cost-control.controller.js';
import { CostControlService } from './cost-control.service.js';

/** Control (docs/wave4-plan.md): cost control and cash flow. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [CostControlController, CashFlowController],
  providers: [CostControlService, CashFlowService],
})
export class ControlModule {}
