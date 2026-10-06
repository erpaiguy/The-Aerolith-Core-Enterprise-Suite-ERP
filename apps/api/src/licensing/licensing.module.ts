import { Module } from '@nestjs/common';
import { OwnerController } from '../owner/owner.controller.js';
import { OwnerGuard } from '../owner/owner.guard.js';
import { LicensingController } from './licensing.controller.js';
import { LicensingService } from './licensing.service.js';

@Module({
  controllers: [LicensingController, OwnerController],
  providers: [LicensingService, OwnerGuard],
  exports: [LicensingService],
})
export class LicensingModule {}
