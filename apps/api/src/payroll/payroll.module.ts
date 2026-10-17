import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { HrModule } from '../hr/hr.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { PayrollGapsController } from './payroll-gaps.controller.js';
import { PayrollGapsService } from './payroll-gaps.service.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';
import { StatutoryController } from './statutory.controller.js';
import { StatutoryService } from './statutory.service.js';

/** Payroll (docs/wave3-plan.md step 12): the rules, salaries, the monthly run, the returns and settlements. */
@Module({
  imports: [ProvisioningModule, AuthModule, ApprovalModule, AccountsModule, HrModule],
  controllers: [PayrollController, StatutoryController, PayrollGapsController],
  providers: [PayrollService, StatutoryService, PayrollGapsService],
})
export class PayrollModule {}
