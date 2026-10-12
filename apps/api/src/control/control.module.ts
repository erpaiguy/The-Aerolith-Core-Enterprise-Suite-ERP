import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { CashFlowController } from './cash-flow.controller.js';
import { CashFlowService } from './cash-flow.service.js';
import { CostControlController } from './cost-control.controller.js';
import { EarnedValueController } from './earned-value.controller.js';
import { EarnedValueService } from './earned-value.service.js';
import { CostControlService } from './cost-control.service.js';

/** Control (docs/wave4-plan.md): cost control, cash flow and earned value. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [CostControlController, CashFlowController, EarnedValueController],
  providers: [CostControlService, CashFlowService, EarnedValueService],
})
export class ControlModule {}
