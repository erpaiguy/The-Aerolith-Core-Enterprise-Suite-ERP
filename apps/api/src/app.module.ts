import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountsModule } from './accounts/accounts.module.js';
import { HrModule } from './hr/hr.module.js';
import { LabourModule } from './labour/labour.module.js';
import { QualityModule } from './quality/quality.module.js';
import { SafetyModule } from './safety/safety.module.js';
import { ControlModule } from './control/control.module.js';
import { DmsModule } from './dms/dms.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { ApprovalModule } from './approvals/approval.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RateLimitGuard } from './auth/rate-limit.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { EmailModule } from './email/email.module.js';
import { HealthController } from './health/health.controller.js';
import { LicensingModule } from './licensing/licensing.module.js';
import { ProcurementModule } from './procurement/procurement.module.js';
import { ProjectModule } from './project/project.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ScheduleModule } from './schedule/schedule.module.js';
import { TenderModule } from './tender/tender.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    ProvisioningModule,
    LicensingModule,
    AuthModule,
    EmailModule,
    TenderModule,
    DocumentsModule,
    ScheduleModule,
    ReportsModule,
    DashboardModule,
    ProjectModule,
    ApprovalModule,
    AccountsModule,
    HrModule,
    PayrollModule,
    LabourModule,
    QualityModule,
    SafetyModule,
    ControlModule,
    DmsModule,
    ProcurementModule,
  ],
  controllers: [HealthController],
  // Runs before route guards; only acts on routes marked with @RateLimit.
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
