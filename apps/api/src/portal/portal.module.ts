import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DmsModule } from '../dms/dms.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderModule } from '../tender/tender.module.js';
import {
  PortalAuthController,
  PortalController,
  PortalStaffController,
} from './portal.controller.js';
import { PortalAuthService } from './portal-auth.service.js';
import { PortalGuard } from './portal.guard.js';
import { PortalService } from './portal.service.js';
import { SubmissionsService } from './submissions.service.js';

/** Vendor, subcontractor and client portals (docs/wave6-plan.md step 5). */
@Module({
  imports: [
    ProvisioningModule,
    AuthModule,
    LicensingModule,
    DocumentsModule,
    DmsModule,
    AccountsModule,
    TenderModule,
  ],
  controllers: [PortalAuthController, PortalController, PortalStaffController],
  providers: [PortalAuthService, PortalGuard, PortalService, SubmissionsService],
})
export class PortalModule {}
