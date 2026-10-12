import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { VariationController } from './variation.controller.js';
import { VariationService } from './variation.service.js';
import { CashFlowController } from './cash-flow.controller.js';
import { CashFlowService } from './cash-flow.service.js';
import { CostControlController } from './cost-control.controller.js';
import { EarnedValueController } from './earned-value.controller.js';
import { EarnedValueService } from './earned-value.service.js';
import { CostControlService } from './cost-control.service.js';

/** Control (docs/wave4-plan.md): cost control, cash flow, earned value and variations. */
@Module({
  imports: [
    ProvisioningModule,
    AuthModule,
    ProjectModule,
    ApprovalModule,
    RatesModule,
    ScheduleModule,
    TenderModule,
  ],
  controllers: [
    CostControlController,
    CashFlowController,
    EarnedValueController,
    VariationController,
  ],
  providers: [CostControlService, CashFlowService, EarnedValueService, VariationService],
})
export class ControlModule {}
