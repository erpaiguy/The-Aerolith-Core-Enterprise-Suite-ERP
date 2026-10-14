import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { LetterheadController } from './letterhead.controller.js';
import { LetterheadService } from './letterhead.service.js';

/** Letterhead for printed documents (docs/wave7-plan.md step 7b.1). */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [LetterheadController],
  providers: [LetterheadService],
})
export class LetterheadModule {}
