import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { AttendanceService } from './attendance.service.js';
import { HrController } from './hr.controller.js';
import { HrService } from './hr.service.js';
import { LeaveService } from './leave.service.js';

/** Wave 3's people (docs/wave3-plan.md step 11): employees, designations, attendance and leave. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, ApprovalModule],
  controllers: [HrController],
  providers: [HrService, LeaveService, AttendanceService],
  exports: [HrService, LeaveService, AttendanceService],
})
export class HrModule {}
