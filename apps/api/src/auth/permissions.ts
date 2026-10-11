// Admin-configurable permissions per role (owner decision, Wave 1). Admins can always do everything; managers and
// workers get the defaults below unless the tenant admin changed them (platform.role_permission).
import {
  CanActivate,
  ForbiddenException,
  Injectable,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantClaims } from './auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export const PERMISSIONS = {
  'tender.edit': {
    label: 'Create and edit tenders and clients, change tender status, record bid/no-bid decisions',
    defaults: { manager: true, worker: false },
  },
  'boq.edit': {
    label: 'Create BOQs and edit their lines',
    defaults: { manager: true, worker: false },
  },
  'rates.edit': {
    label: 'Edit the rate library: resources, their rates, price books and rate analyses',
    defaults: { manager: true, worker: false },
  },
  'pricing.edit': {
    label: 'See and change bid pricing: markups, profit, GST, scenarios and quoted rates',
    defaults: { manager: true, worker: false },
  },
  'rfq.edit': {
    label:
      'Run enquiries to vendors: RFQs, quotes, comparative statements and the choice of vendor',
    defaults: { manager: true, worker: false },
  },
  'documents.edit': {
    label:
      'Upload, organise and remove tender documents (restricted folders also need the pricing permission)',
    defaults: { manager: true, worker: true },
  },
  'programme.edit': {
    label: 'Create and edit tender programmes: activities, links, calendars',
    defaults: { manager: true, worker: false },
  },
  'projects.edit': {
    label:
      'Create projects (also from won tenders), and edit any project they can see: details, sites and team',
    defaults: { manager: true, worker: false },
  },
  'projects.all': {
    label: 'See every project, not only those they are on the team of',
    defaults: { manager: true, worker: false },
  },
  'costcodes.edit': {
    label: "Edit the company's cost codes",
    defaults: { manager: true, worker: false },
  },
  'purchase.edit': {
    label:
      "Make, amend and cancel a project's purchase and work orders (they still go through the approval rules)",
    defaults: { manager: true, worker: false },
  },
  'stores.receive': {
    label:
      "Receive goods against a project's purchase orders at its sites, inspect what is held and return rejections",
    defaults: { manager: true, worker: true },
  },
  'stores.manage': {
    label:
      "Set up a project's stores, transfer stock out of them and count it (stock adjustments go through the approval rules)",
    defaults: { manager: true, worker: false },
  },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export type ConfigurableRole = 'manager' | 'worker';
export const CONFIGURABLE_ROLES: ConfigurableRole[] = ['manager', 'worker'];
export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

type Grants = Record<ConfigurableRole, Record<Permission, boolean>>;

const PERMISSION_KEY = 'aerolith:permission';
/** The route needs this permission (admins always have it). Use with TenantAuthGuard, then PermissionGuard. */
export const RequiresPermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);

const CACHE_MS = 30_000;

@Injectable()
export class PermissionsService {
  private readonly cache = new Map<string, { at: number; grants: Grants }>();

  constructor(private readonly tenants: TenantConnections) {}

  async grants(tenantId: string, now = Date.now()): Promise<Grants> {
    const hit = this.cache.get(tenantId);
    if (hit && now - hit.at < CACHE_MS) return hit.grants;
    const db = await this.tenants.forTenant(tenantId);
    const rows = await db<{ role: ConfigurableRole; permission: string; granted: boolean }[]>`
      SELECT role, permission, granted FROM platform.role_permission`;
    const grants = Object.fromEntries(
      CONFIGURABLE_ROLES.map((role) => [
        role,
        Object.fromEntries(
          Object.entries(PERMISSIONS).map(([p, def]) => [
            p,
            rows.find((r) => r.role === role && r.permission === p)?.granted ?? def.defaults[role],
          ]),
        ),
      ]),
    ) as Grants;
    this.cache.set(tenantId, { at: now, grants });
    return grants;
  }

  async can(claims: TenantClaims, p: Permission): Promise<boolean> {
    if (claims.role === 'admin') return true;
    return (await this.grants(claims.ten))[claims.role][p];
  }

  async mine(claims: TenantClaims): Promise<Permission[]> {
    const all = Object.keys(PERMISSIONS) as Permission[];
    if (claims.role === 'admin') return all;
    const g = (await this.grants(claims.ten))[claims.role];
    return all.filter((p) => g[p]);
  }

  async set(claims: TenantClaims, role: ConfigurableRole, p: Permission, granted: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`INSERT INTO platform.role_permission (role, permission, granted, updated_by)
        VALUES (${role}, ${p}, ${granted}, ${claims.sub})
        ON CONFLICT (role, permission) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'permission.set', 'role', ${role}, ${tx.json({ permission: p, granted })})`;
    });
    this.cache.delete(claims.ten);
    return this.grants(claims.ten);
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const p = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!p) return true;
    const claims = context.switchToHttp().getRequest<{ auth?: TenantClaims }>().auth;
    if (!claims) throw new ForbiddenException({ code: 'forbidden' });
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: p,
        message: 'Your role does not allow this. Ask your admin.',
      });
    return true;
  }
}
