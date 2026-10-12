import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';
import { MepService } from './mep.service.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';
import { RisksController } from './risks.controller.js';
import { RisksService } from './risks.service.js';
import { VariationController } from './variation.controller.js';
import { VariationService } from './variation.service.js';
import { CashFlowController } from './cash-flow.controller.js';
import { CashFlowService } from './cash-flow.service.js';
import { CostControlController } from './cost-control.controller.js';
import { EarnedValueController } from './earned-value.controller.js';
import { EarnedValueService } from './earned-value.service.js';
import { CostControlService } from './cost-control.service.js';

/** Control (docs/wave4-plan.md): cost control, cash flow, earned value, variations, contracts and claims, risks, the portfolio, reviews and the MEP pack. */
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
    ContractsController,
    RisksController,
    ReviewController,
  ],
  providers: [
    CostControlService,
    CashFlowService,
    EarnedValueService,
    VariationService,
    ContractsService,
    RisksService,
    MepService,
    ReviewService,
  ],
})
export class ControlModule {}
