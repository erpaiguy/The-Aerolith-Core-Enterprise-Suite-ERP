import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/** The audit trail (docs/wave7-plan.md step 7a.8). */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
