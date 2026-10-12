import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { MarkupController } from './markup.controller.js';
import { MarkupService } from './markup.service.js';
import { RfiService } from './rfi.service.js';
import { ShareController, TransmittalController } from './transmittal.controller.js';
import { TransmittalService } from './transmittal.service.js';
import { CheckController, RevisionController } from './revision.controller.js';
import { RevisionService } from './revision.service.js';
import { SignoffController } from './signoff.controller.js';
import { SignoffService } from './signoff.service.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

/** Document workflow (docs/wave5-plan.md): reviews, mark-up and comments, transmittals, RFIs and submittals. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, DocumentsModule, LicensingModule],
  controllers: [
    ReviewController,
    MarkupController,
    TransmittalController,
    ShareController,
    RevisionController,
    CheckController,
    SignoffController,
  ],
  providers: [
    ReviewService,
    MarkupService,
    TransmittalService,
    RfiService,
    RevisionService,
    SignoffService,
  ],
  exports: [ReviewService, TransmittalService],
})
export class DmsModule {}
