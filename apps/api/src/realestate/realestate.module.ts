import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

/** Real estate sales and RERA (docs/wave6-plan.md step 2). */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, AccountsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class RealEstateModule {}
