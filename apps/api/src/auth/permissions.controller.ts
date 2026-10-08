import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { TenantClaims } from './auth.service.js';
import { AllowWhilePasswordChangeRequired, Auth, Roles, TenantAuthGuard } from './guards.js';
import {
  CONFIGURABLE_ROLES,
  PERMISSIONS,
  PermissionsService,
  isPermission,
  type Permission,
} from './permissions.js';

const setBody = z.object({
  role: z.enum(['manager', 'worker']),
  permission: z.string().refine(isPermission, { message: 'Unknown permission' }),
  granted: z.boolean(),
});

/** "What each role can do" (Users page). Admins change it; everyone can ask what they themselves may do. */
@Controller('tenant/permissions')
@UseGuards(TenantAuthGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get('mine')
  @AllowWhilePasswordChangeRequired()
  mine(@Auth() c: TenantClaims) {
    return this.permissions.mine(c);
  }

  @Get()
  @Roles('admin')
  async all(@Auth() c: TenantClaims) {
    return {
      roles: CONFIGURABLE_ROLES,
      permissions: Object.entries(PERMISSIONS).map(([key, p]) => ({ key, label: p.label })),
      grants: await this.permissions.grants(c.ten),
    };
  }

  @Post()
  @HttpCode(200)
  @Roles('admin')
  async set(@Auth() c: TenantClaims, @Body(new ZodPipe(setBody)) b: z.infer<typeof setBody>) {
    return { grants: await this.permissions.set(c, b.role, b.permission as Permission, b.granted) };
  }
}
