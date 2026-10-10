import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RequisitionController } from './requisition.controller.js';
import { RequisitionService } from './requisition.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, ApprovalModule],
  controllers: [RequisitionController],
  providers: [RequisitionService],
})
export class ProcurementModule {}
