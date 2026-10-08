import { Module } from '@nestjs/common';
import { InboxController } from '../inbox/inbox.controller.js';
import { InboxService } from '../inbox/inbox.service.js';
import { LicensingModule } from '../licensing/licensing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import {
  AuthController,
  OperatorAuthController,
  TenantUsersController,
} from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { OperatorAuthService } from './operator-auth.service.js';
import { OperatorSessionController } from './operator-session.controller.js';
import { PermissionsController } from './permissions.controller.js';
import { PermissionGuard, PermissionsService } from './permissions.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [LicensingModule, ProvisioningModule],
  controllers: [
    AuthController,
    TenantUsersController,
    OperatorAuthController,
    OperatorSessionController,
    InboxController,
    PermissionsController,
  ],
  providers: [
    AuthService,
    UsersService,
    MfaService,
    OperatorAuthService,
    InboxService,
    PermissionsService,
    PermissionGuard,
  ],
  exports: [OperatorAuthService, PermissionsService, PermissionGuard],
})
export class AuthModule {}
