import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { OwnerConsoleController } from '../owner/owner-console.controller.js';
import { OwnerConsoleService } from '../owner/owner-console.service.js';
import { OwnerController } from '../owner/owner.controller.js';
import { LicensingController } from './licensing.controller.js';
import { LicensingService } from './licensing.service.js';

@Module({
  imports: [ProvisioningModule],
  controllers: [LicensingController, OwnerController, OwnerConsoleController],
  providers: [LicensingService, OwnerConsoleService],
  exports: [LicensingService],
})
export class LicensingModule {}
