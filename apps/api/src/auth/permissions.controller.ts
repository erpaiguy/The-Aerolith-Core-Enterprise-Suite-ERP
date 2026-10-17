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
import { AccessProfilesService } from './access-profiles.service.js';
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

const profile = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  permissions: z
    .array(z.string().refine(isPermission, { message: 'Unknown permission' }))
    .max(100)
    .transform((ps) => [...new Set(ps)] as Permission[]),
});
const profileUpdate = profile.extend({ rowVersion: z.number().int().positive() });
const assign = z.object({ userId: z.uuid(), profileId: z.uuid().nullable() });

/** "What each role can do" (Users page). Admins change it; everyone can ask what they themselves may do. */
@Controller('tenant/permissions')
@UseGuards(TenantAuthGuard)
export class PermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly profiles: AccessProfilesService,
  ) {}

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

  // --- access profiles: custom roles (docs/wave8-plan.md step 8g.4) ---

  @Get('profiles')
  @Roles('admin')
  listProfiles(@Auth() c: TenantClaims) {
    return this.profiles.list(c);
  }

  @Post('profiles')
  @HttpCode(200)
  @Roles('admin')
  createProfile(@Auth() c: TenantClaims, @Body(new ZodPipe(profile)) b: z.infer<typeof profile>) {
    return this.profiles.create(c, b);
  }

  @Post('profiles/assign')
  @HttpCode(200)
  @Roles('admin')
  assignProfile(@Auth() c: TenantClaims, @Body(new ZodPipe(assign)) b: z.infer<typeof assign>) {
    return this.profiles.assign(c, b.userId, b.profileId);
  }

  @Post('profiles/:id')
  @HttpCode(200)
  @Roles('admin')
  updateProfile(
    @Auth() c: TenantClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(profileUpdate)) b: z.infer<typeof profileUpdate>,
  ) {
    const { rowVersion, ...input } = b;
    return this.profiles.update(c, id, rowVersion, input);
  }

  @Post('profiles/:id/delete')
  @HttpCode(200)
  @Roles('admin')
  deleteProfile(@Auth() c: TenantClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.remove(c, id);
  }
}
