import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { OwnerController } from '../owner/owner.controller.js';
import { LicensingController } from './licensing.controller.js';
import { LicensingService } from './licensing.service.js';

@Module({
  imports: [ProvisioningModule],
  controllers: [LicensingController, OwnerController],
  providers: [LicensingService],
  exports: [LicensingService],
})
export class LicensingModule {}
