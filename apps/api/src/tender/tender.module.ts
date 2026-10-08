import { Module } from '@nestjs/common';
import { BoqController } from '../boq/boq.controller.js';
import { BoqService } from '../boq/boq.service.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderController } from './tender.controller.js';
import { TenderService } from './tender.service.js';

@Module({
  imports: [ProvisioningModule],
  controllers: [TenderController, BoqController],
  providers: [TenderService, BoqService],
})
export class TenderModule {}
