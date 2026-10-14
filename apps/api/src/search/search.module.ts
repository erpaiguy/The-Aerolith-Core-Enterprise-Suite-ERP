import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** Search everything (docs/wave7-plan.md step 7a.6). */
@Module({
  imports: [ProvisioningModule, AuthModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
