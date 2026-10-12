import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { BiController } from './bi.controller.js';
import { BiService } from './bi.service.js';

/** The report builder (docs/wave6-plan.md step 3). */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [BiController],
  providers: [BiService],
  exports: [BiService],
})
export class BiModule {}
