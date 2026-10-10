import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ApprovalController } from './approval.controller.js';
import { ApprovalService } from './approval.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [ApprovalController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
