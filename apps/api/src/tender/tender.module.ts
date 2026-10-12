import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BoqController } from '../boq/boq.controller.js';
import { BoqService } from '../boq/boq.service.js';
import { TemplateController } from '../boq/template.controller.js';
import { TemplateService } from '../boq/template.service.js';
import { RevisionService } from '../boq/revision.service.js';
import { ExportService } from '../boq/import/export.service.js';
import { ImportController } from '../boq/import/import.controller.js';
import { ImportService } from '../boq/import/import.service.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { RfqController } from '../rfq/rfq.controller.js';
import { RfqService } from '../rfq/rfq.service.js';
import { TenderSettingsController } from './tender-settings.controller.js';
import { TenderSettingsService } from './tender-settings.service.js';
import { TenderWorkController } from './tender-work.controller.js';
import { TenderWorkService } from './tender-work.service.js';
import { TenderController } from './tender.controller.js';
import { TenderService } from './tender.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, RatesModule, PricingModule],
  controllers: [
    TenderController,
    TenderWorkController,
    BoqController,
    ImportController,
    RfqController,
    TemplateController,
    TenderSettingsController,
  ],
  providers: [
    TenderService,
    TenderWorkService,
    BoqService,
    ImportService,
    ExportService,
    RevisionService,
    RfqService,
    TemplateService,
    TenderSettingsService,
  ],
  exports: [RevisionService, RfqService, BoqService, TenderService],
})
export class TenderModule {}
