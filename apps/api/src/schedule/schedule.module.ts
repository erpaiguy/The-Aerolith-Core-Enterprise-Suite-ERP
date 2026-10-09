import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ProgrammeController } from './programme.controller.js';
import { ProgrammeService } from './programme.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [ProgrammeController],
  providers: [ProgrammeService],
})
export class ScheduleModule {}
