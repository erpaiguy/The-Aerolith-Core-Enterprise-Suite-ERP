import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RegistersController } from './registers.controller.js';
import { RegistersService } from './registers.service.js';

/** Company-wide registers of project records (docs/wave7-plan.md step 7a.3). */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [RegistersController],
  providers: [RegistersService],
})
export class RegistersModule {}
