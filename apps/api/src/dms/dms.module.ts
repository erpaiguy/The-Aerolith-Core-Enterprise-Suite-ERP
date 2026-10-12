import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

/** Document workflow (docs/wave5-plan.md): reviews. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule],
  controllers: [ReviewController],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class DmsModule {}
