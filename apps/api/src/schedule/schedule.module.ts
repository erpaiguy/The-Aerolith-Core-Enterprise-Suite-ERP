import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ProgrammeController } from './programme.controller.js';
import { DashboardService } from './dashboard.service.js';
import { MacroService } from './macro.service.js';
import { MakeReadyController } from './make-ready.controller.js';
import { MakeReadyService } from './make-ready.service.js';
import { ProgrammeService } from './programme.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [ProgrammeController, MakeReadyController],
  providers: [ProgrammeService, MacroService, DashboardService, MakeReadyService],
  exports: [ProgrammeService],
})
export class ScheduleModule {}
