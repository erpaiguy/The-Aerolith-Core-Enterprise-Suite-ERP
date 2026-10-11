import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';

/** Wave 3's money (docs/wave3-plan.md): the books first; billing, payables and the rest post into them. */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class AccountsModule {}
