import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderController } from './tender.controller.js';
import { TenderService } from './tender.service.js';

@Module({
  imports: [ProvisioningModule],
  controllers: [TenderController],
  providers: [TenderService],
})
export class TenderModule {}
