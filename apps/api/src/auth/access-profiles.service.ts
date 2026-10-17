// Custom roles as access profiles (docs/wave8-plan.md step 8g.4): an admin names a set of permissions and gives it
// to managers or workers, whose role permissions it then replaces. Admins are never given one.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantClaims } from './auth.service.js';
import { PermissionsService, type Permission } from './permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';

export interface ProfileInput {
  name: string;
  description: string;
  permissions: Permission[];
}

const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this. Reload to see their changes.',
  });

@Injectable()
export class AccessProfilesService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  async list(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT p.id, p.name, p.description, p.permissions, p.row_version AS "rowVersion",
        coalesce(json_agg(json_build_object('id', u.id, 'name', u.display_name, 'role', u.role)
          ORDER BY u.display_name) FILTER (WHERE u.id IS NOT NULL), '[]') AS users
      FROM platform.access_profile p LEFT JOIN platform."user" u ON u.access_profile_id = p.id
      GROUP BY p.id ORDER BY lower(p.name)`;
  }

  private async named(claims: TenantClaims, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictException({
          code: 'name_taken',
          message: 'A profile has this name already.',
        });
      throw err;
    }
    this.permissions.forget(claims.ten);
    return this.list(claims);
  }

  create(claims: TenantClaims, input: ProfileInput) {
    return this.named(claims, async () => {
      const db = await this.tenants.forTenant(claims.ten);
      await db.begin(async (tx) => {
        const [p] = await tx<{ id: string }[]>`
          INSERT INTO platform.access_profile (name, description, permissions, created_by)
          VALUES (${input.name}, ${input.description}, ${input.permissions}, ${claims.sub}) RETURNING id`;
        await audit(tx, claims.sub, 'access_profile.create', 'access_profile', p!.id, { ...input });
      });
    });
  }

  update(claims: TenantClaims, id: string, rowVersion: number, input: ProfileInput) {
    return this.named(claims, async () => {
      const db = await this.tenants.forTenant(claims.ten);
      await db.begin(async (tx) => {
        const [p] = await tx<{ row_version: number }[]>`
          SELECT row_version FROM platform.access_profile WHERE id = ${id} FOR UPDATE`;
        if (!p) throw new NotFoundException({ code: 'not_found', message: 'No such profile.' });
        if (p.row_version !== rowVersion) throw stale();
        await tx`
          UPDATE platform.access_profile SET name = ${input.name}, description = ${input.description},
            permissions = ${input.permissions}, updated_at = now(), row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'access_profile.update', 'access_profile', id, { ...input });
      });
    });
  }

  async remove(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM platform."user" WHERE access_profile_id = ${id}`;
      if (n!.n > 0)
        throw new ConflictException({
          code: 'profile_in_use',
          message: `${n!.n} ${n!.n === 1 ? 'person has' : 'people have'} this profile. Give them another first.`,
        });
      const gone = await tx`DELETE FROM platform.access_profile WHERE id = ${id}`;
      if (!gone.count)
        throw new NotFoundException({ code: 'not_found', message: 'No such profile.' });
      await audit(tx, claims.sub, 'access_profile.delete', 'access_profile', id, {});
    });
    this.permissions.forget(claims.ten);
    return this.list(claims);
  }

  /** Gives a manager or worker a profile, or takes it away (null: back to their role's permissions). */
  async assign(claims: TenantClaims, userId: string, profileId: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [u] = await tx<
        { role: string }[]
      >`SELECT role FROM platform."user" WHERE id = ${userId} FOR UPDATE`;
      if (!u) throw new NotFoundException({ code: 'not_found', message: 'No such user.' });
      if (u.role === 'admin' && profileId)
        throw new BadRequestException({
          code: 'admin_unlimited',
          message: 'Admins can always do everything; a profile would not limit them.',
        });
      if (profileId) {
        const [p] = await tx`SELECT 1 FROM platform.access_profile WHERE id = ${profileId}`;
        if (!p) throw new NotFoundException({ code: 'not_found', message: 'No such profile.' });
      }
      await tx`UPDATE platform."user" SET access_profile_id = ${profileId} WHERE id = ${userId}`;
      await audit(tx, claims.sub, 'access_profile.assign', 'user', userId, { profileId });
    });
    this.permissions.forget(claims.ten);
    return this.list(claims);
  }
}
