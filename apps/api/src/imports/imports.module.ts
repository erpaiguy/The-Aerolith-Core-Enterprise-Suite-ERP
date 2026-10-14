import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HrModule } from '../hr/hr.module.js';
import { LabourModule } from '../labour/labour.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

/** Bulk imports from Excel (docs/wave7-plan.md step 7c.8). */
@Module({
  imports: [ProvisioningModule, AuthModule, TenderModule, HrModule, LabourModule, RatesModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
