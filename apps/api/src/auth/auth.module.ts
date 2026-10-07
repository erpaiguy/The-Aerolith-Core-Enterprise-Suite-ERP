import { Module } from '@nestjs/common';
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
import { UsersService } from './users.service.js';

@Module({
  imports: [LicensingModule, ProvisioningModule],
  controllers: [
    AuthController,
    TenantUsersController,
    OperatorAuthController,
    OperatorSessionController,
  ],
  providers: [AuthService, UsersService, MfaService, OperatorAuthService],
  exports: [OperatorAuthService],
})
export class AuthModule {}
