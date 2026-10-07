import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService, type TenantClaims } from './auth.service.js';
import {
  AllowWhilePasswordChangeRequired,
  Auth,
  RequiresFeatures,
  Roles,
  TenantAuthGuard,
} from './guards.js';
import { MfaService } from './mfa.service.js';
import { OperatorAuthService } from './operator-auth.service.js';
import { RateLimit } from './rate-limit.js';
import { UsersService } from './users.service.js';

const password = z.string().min(1).max(256);
const loginSchema = z.object({
  entitlementToken: z.string().min(10).max(4096),
  identifier: z.string().trim().min(1).max(254),
  password,
  code: z.string().trim().max(20).optional(),
  client: z.enum(['browser', 'desktop']),
});
const refreshSchema = z.object({ refreshToken: z.string().min(10).max(512) });
const changePasswordSchema = z.object({ currentPassword: password, newPassword: password });
const resetRequestSchema = z.object({
  entitlementToken: z.string().min(10).max(4096),
  username: z.string().trim().min(1).max(64),
  deviceLabel: z.string().max(100).nullable().default(null),
});
const emailSchema = z.object({ email: z.string().email().max(254) });
const setPasswordSchema = z.object({ token: z.string().min(20).max(200), newPassword: password });
const enrollSchema = z.object({ enrollmentToken: z.string().min(10).max(2048) });
const confirmSchema = z.object({
  enrollmentToken: z.string().min(10).max(2048),
  code: z.string().trim().min(6).max(6),
});
const createUserSchema = z.object({
  username: z.string().trim().min(3).max(40),
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(['manager', 'worker']),
});
const roleSchema = z.object({ role: z.enum(['manager', 'worker']) });
const operatorLoginSchema = z.object({
  email: z.string().email().max(254),
  password,
  code: z.string().trim().max(20).optional(),
});

/** Sign-in for tenant admins and staff (desktop and browser app). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @RateLimit(10)
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit(60)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(TenantAuthGuard)
  @AllowWhilePasswordChangeRequired()
  async logout(@Auth() claims: TenantClaims): Promise<void> {
    await this.auth.logout(claims);
  }

  @Get('me')
  @UseGuards(TenantAuthGuard)
  @AllowWhilePasswordChangeRequired()
  me(@Auth() claims: TenantClaims) {
    return this.auth.me(claims);
  }

  @Post('change-password')
  @HttpCode(200)
  @RateLimit(10)
  @UseGuards(TenantAuthGuard)
  @AllowWhilePasswordChangeRequired()
  changePassword(
    @Auth() claims: TenantClaims,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    return this.auth.changePassword(claims, body.currentPassword, body.newPassword);
  }

  /** Staff: ask the tenant admin for a new password. Always 202, whatever the username. */
  @Post('password-reset-request')
  @HttpCode(202)
  @RateLimit(5)
  async passwordResetRequest(
    @Body(new ZodPipe(resetRequestSchema)) body: z.infer<typeof resetRequestSchema>,
  ) {
    await this.auth.requestPasswordReset(body.entitlementToken, body.username, body.deviceLabel);
    return {
      status: 'requested',
      message: 'If that username exists, your admin has been asked to reset it.',
    };
  }

  /** Tenant admin: emails a reset link. Always 202. */
  @Post('admin/forgot-password')
  @HttpCode(202)
  @RateLimit(5)
  async adminForgotPassword(@Body(new ZodPipe(emailSchema)) body: z.infer<typeof emailSchema>) {
    await this.auth.adminForgotPassword(body.email);
    return { status: 'sent', message: 'If that email is registered, a reset link is on its way.' };
  }

  /** Tenant admin: completes a setup or reset link. */
  @Post('admin/set-password')
  @HttpCode(200)
  @RateLimit(10)
  async adminSetPassword(
    @Body(new ZodPipe(setPasswordSchema)) body: z.infer<typeof setPasswordSchema>,
  ) {
    await this.auth.adminSetPassword(body.token, body.newPassword);
    return { status: 'password_set' };
  }

  /** MFA enrolment for tenant admins and operators (the token says which). */
  @Post('mfa/enroll')
  @HttpCode(200)
  @RateLimit(10)
  enroll(@Body(new ZodPipe(enrollSchema)) body: z.infer<typeof enrollSchema>) {
    return this.mfa.startEnrollment(body.enrollmentToken);
  }

  @Post('mfa/confirm')
  @HttpCode(200)
  @RateLimit(10)
  confirm(@Body(new ZodPipe(confirmSchema)) body: z.infer<typeof confirmSchema>) {
    return this.mfa.confirmEnrollment(body.enrollmentToken, body.code);
  }
}

/** Tenant admin: staff accounts, reset requests. Any signed-in user: own notifications. */
@Controller('tenant')
@UseGuards(TenantAuthGuard)
export class TenantUsersController {
  constructor(private readonly users: UsersService) {}

  @Get('notifications')
  notifications(@Auth() claims: TenantClaims) {
    return this.users.notifications(claims);
  }

  @Get('users')
  @Roles('admin')
  list(@Auth() claims: TenantClaims) {
    return this.users.list(claims);
  }

  @Post('users')
  @Roles('admin')
  @RequiresFeatures()
  create(
    @Auth() claims: TenantClaims,
    @Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>,
  ) {
    return this.users.create(claims, body);
  }

  @Post('users/:id/deactivate')
  @HttpCode(200)
  @Roles('admin')
  deactivate(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.deactivate(claims, id);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  reactivate(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.reactivate(claims, id);
  }

  @Post('users/:id/role')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  changeRole(
    @Auth() claims: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(roleSchema)) body: z.infer<typeof roleSchema>,
  ) {
    return this.users.changeRole(claims, id, body.role);
  }

  @Get('password-resets')
  @Roles('admin')
  pendingResets(@Auth() claims: TenantClaims) {
    return this.users.pendingResets(claims);
  }

  @Post('password-resets/:id/issue')
  @HttpCode(200)
  @Roles('admin')
  issueReset(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.issueReset(claims, id);
  }

  @Post('password-resets/:id/dismiss')
  @HttpCode(200)
  @Roles('admin')
  dismissReset(@Auth() claims: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.dismissReset(claims, id);
  }
}

/** Owner console sign-in (platform operators). */
@Controller('owner/auth')
export class OperatorAuthController {
  constructor(private readonly operators: OperatorAuthService) {}

  @Post('login')
  @HttpCode(200)
  @RateLimit(10)
  login(@Body(new ZodPipe(operatorLoginSchema)) body: z.infer<typeof operatorLoginSchema>) {
    return this.operators.login(body.email, body.password, body.code);
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit(60)
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.operators.refresh(body.refreshToken);
  }
}
