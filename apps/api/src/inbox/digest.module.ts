import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { DigestController } from './digest.controller.js';
import { DigestService } from './digest.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [DigestController],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}
