import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { LetterController } from './letter.controller.js';
import { LetterService } from './letter.service.js';
import { MeetingController } from './meeting.controller.js';
import { ItpController } from './itp.controller.js';
import { ItpService } from './itp.service.js';
import { MdlController } from './mdl.controller.js';
import { MdlService } from './mdl.service.js';
import { MeetingService } from './meeting.service.js';

/** Wave 7d's project registers (docs/wave7-plan.md): meetings, correspondence, documents expected, ITPs, safety walks. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [MeetingController, LetterController, MdlController, ItpController],
  providers: [MeetingService, LetterService, MdlService, ItpService],
})
export class ProjectRegistersModule {}
