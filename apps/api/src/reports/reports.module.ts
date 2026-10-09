import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, RatesModule, PricingModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
