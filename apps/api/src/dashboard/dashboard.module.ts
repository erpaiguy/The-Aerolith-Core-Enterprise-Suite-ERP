import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { CompanyDashboardController } from './company.controller.js';
import { CompanyDashboardService } from './company.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, RatesModule, AccountsModule],
  controllers: [DashboardController, CompanyDashboardController],
  providers: [DashboardService, CompanyDashboardService],
})
export class DashboardModule {}
