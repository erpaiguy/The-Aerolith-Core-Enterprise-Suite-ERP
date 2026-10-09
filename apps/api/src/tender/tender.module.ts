import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BoqController } from '../boq/boq.controller.js';
import { BoqService } from '../boq/boq.service.js';
import { ExportService } from '../boq/import/export.service.js';
import { ImportController } from '../boq/import/import.controller.js';
import { ImportService } from '../boq/import/import.service.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { TenderController } from './tender.controller.js';
import { TenderService } from './tender.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, RatesModule, PricingModule],
  controllers: [TenderController, BoqController, ImportController],
  providers: [TenderService, BoqService, ImportService, ExportService],
})
export class TenderModule {}
