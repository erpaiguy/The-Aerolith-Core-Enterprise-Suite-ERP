// Staff accounts managed by the tenant admin, with seat enforcement (docs/06-pricing.md: named seats, immediate reuse).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TransactionSql } from 'postgres';
import { checkSeat, type Role } from '../licensing/licence-rules.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import type { TenantClaims } from './auth.service.js';
import { hashPassword, temporaryPassword } from './password.js';

export type StaffRole = 'manager' | 'worker';
const SEAT_LOCK = 4_242_001; // per-database advisory lock: seat checks never race

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/i;

@Injectable()
export class UsersService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly licensing: LicensingService,
  ) {}

  async list(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT id, username, display_name AS "displayName", email, role, status, must_change_password AS "mustChangePassword",
        last_login_at AS "lastLoginAt", created_at AS "createdAt"
      FROM platform."user" ORDER BY role = 'admin' DESC, lower(username)`;
  }

  async create(
    claims: TenantClaims,
    input: { username: string; displayName: string; role: StaffRole },
  ) {
    if (!USERNAME.test(input.username)) {
      throw new BadRequestException({
        code: 'invalid_username',
        message: '3-40 letters, digits, dot, dash or underscore.',
      });
    }
    const db = await this.tenants.forTenant(claims.ten);
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const user = await db.begin(async (tx) => {
      await this.assertSeat(tx, claims.ten, input.role);
      try {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO platform."user" (username, display_name, role, password_hash, must_change_password)
          VALUES (${input.username}, ${input.displayName}, ${input.role}, ${hash}, true) RETURNING id`;
        await this.audit(tx, claims.sub, 'user.create', row!.id, {
          username: input.username,
          role: input.role,
        });
        return row!;
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({ code: 'username_taken' });
        throw err;
      }
    });
    return { id: user.id, username: input.username, role: input.role, temporaryPassword: password };
  }

  async deactivate(claims: TenantClaims, userId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const target = await this.staff(tx, userId);
      if (target.status === 'deactivated') return { id: userId, status: 'deactivated' };
      await tx`UPDATE platform."user" SET status = 'deactivated', updated_at = now() WHERE id = ${userId}`;
      await tx`UPDATE platform.session SET revoked_at = now(), revoked_reason = 'user_deactivated'
        WHERE user_id = ${userId} AND revoked_at IS NULL`;
      await this.audit(tx, claims.sub, 'user.deactivate', userId);
      return { id: userId, status: 'deactivated' };
    });
  }

  async reactivate(claims: TenantClaims, userId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const target = await this.staff(tx, userId);
      if (target.status === 'active') return { id: userId, status: 'active' };
      await this.assertSeat(tx, claims.ten, target.role);
      await tx`UPDATE platform."user" SET status = 'active', updated_at = now() WHERE id = ${userId}`;
      await this.audit(tx, claims.sub, 'user.reactivate', userId);
      return { id: userId, status: 'active' };
    });
  }

  async changeRole(claims: TenantClaims, userId: string, role: StaffRole) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const target = await this.staff(tx, userId);
      if (target.role === role) return { id: userId, role };
      if (target.status === 'active') await this.assertSeat(tx, claims.ten, role, userId);
      await tx`UPDATE platform."user" SET role = ${role}, updated_at = now() WHERE id = ${userId}`;
      await this.audit(tx, claims.sub, 'user.role_change', userId, { from: target.role, to: role });
      return { id: userId, role };
    });
  }

  /**
   * Renames a user (the name shown on tenders, reminders and in the activity log): the user themselves, or the
   * admin for anyone. The tenant admin starts with their email address as their name.
   */
  async rename(claims: TenantClaims, userId: string, displayName: string) {
    if (claims.role !== 'admin' && claims.sub !== userId)
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only the admin can rename other users.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [u] = await tx<{ display_name: string }[]>`
        SELECT display_name FROM platform."user" WHERE id = ${userId} FOR UPDATE`;
      if (!u) throw new NotFoundException({ code: 'user_not_found' });
      if (u.display_name !== displayName) {
        await tx`UPDATE platform."user" SET display_name = ${displayName}, updated_at = now() WHERE id = ${userId}`;
        await this.audit(tx, claims.sub, 'user.rename', userId, {
          from: u.display_name,
          to: displayName,
        });
      }
      return { id: userId, displayName };
    });
  }

  /** The admin sets anyone's email address (for the morning email, docs/debug-log.md D-12); null clears it. */
  async setEmail(claims: TenantClaims, userId: string, email: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [u] = await tx<{ email: string | null }[]>`
        SELECT email FROM platform."user" WHERE id = ${userId} FOR UPDATE`;
      if (!u) throw new NotFoundException({ code: 'user_not_found' });
      const next = email?.trim().toLowerCase() || null;
      if (u.email !== next) {
        await tx`UPDATE platform."user" SET email = ${next}, updated_at = now() WHERE id = ${userId}`;
        await this.audit(tx, claims.sub, 'user.email', userId, { from: u.email, to: next });
      }
      return { id: userId, email: next };
    });
  }

  async pendingResets(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT r.id, r.requested_at AS "requestedAt", r.device_label AS "deviceLabel",
        u.id AS "userId", u.username, u.display_name AS "displayName"
      FROM platform.password_reset_request r JOIN platform."user" u ON u.id = r.user_id
      WHERE r.status = 'pending' ORDER BY r.requested_at`;
  }

  /** Issues a one-time temporary password (shown once to the admin). The user must change it at next sign-in. */
  async issueReset(claims: TenantClaims, requestId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    return db.begin(async (tx) => {
      const [req] = await tx<{ user_id: string; username: string }[]>`
        UPDATE platform.password_reset_request r SET status = 'issued', actioned_by = ${claims.sub}, actioned_at = now()
        FROM platform."user" u WHERE r.id = ${requestId} AND r.status = 'pending' AND u.id = r.user_id
        RETURNING r.user_id, u.username`;
      if (!req) throw new NotFoundException({ code: 'request_not_found' });
      await tx`UPDATE platform."user" SET password_hash = ${hash}, must_change_password = true, failed_logins = 0,
        locked_until = NULL, updated_at = now() WHERE id = ${req.user_id}`;
      await tx`UPDATE platform.session SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE user_id = ${req.user_id} AND revoked_at IS NULL`;
      await this.audit(tx, claims.sub, 'user.password_reset_issued', req.user_id);
      return { userId: req.user_id, username: req.username, temporaryPassword: password };
    });
  }

  async dismissReset(claims: TenantClaims, requestId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] =
      await db`UPDATE platform.password_reset_request SET status = 'dismissed', actioned_by = ${claims.sub},
      actioned_at = now() WHERE id = ${requestId} AND status = 'pending' RETURNING 1`;
    if (!row) throw new NotFoundException({ code: 'request_not_found' });
    return { id: requestId, status: 'dismissed' };
  }

  private async assertSeat(
    tx: TransactionSql,
    tenantId: string,
    role: Role,
    excludeUserId?: string,
  ): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(${SEAT_LOCK})`;
    const licence = await this.licensing.tenantLicence(tenantId);
    const rows = await tx<{ role: Role; n: number }[]>`
      SELECT role, count(*)::int AS n FROM platform."user"
      WHERE status = 'active' ${excludeUserId ? tx`AND id <> ${excludeUserId}` : tx``} GROUP BY role`;
    const counts = Object.fromEntries(rows.map((r) => [r.role, r.n])) as Partial<
      Record<Role, number>
    >;
    const check = checkSeat({ seatCap: licence.seatCap, roleCaps: licence.roleCaps }, counts, role);
    if (!check.ok) {
      throw new ConflictException({
        code: check.reason,
        limit: check.limit,
        message:
          check.reason === 'seat_cap_reached'
            ? `All ${check.limit} seats are in use. Deactivate a user or upgrade to a tier with more seats.`
            : `Your plan allows ${check.limit} user(s) with this role.`,
      });
    }
  }

  private async staff(tx: TransactionSql, userId: string) {
    const [u] = await tx<{ role: StaffRole | 'admin'; status: string }[]>`
      SELECT role, status FROM platform."user" WHERE id = ${userId} FOR UPDATE`;
    if (!u) throw new NotFoundException({ code: 'user_not_found' });
    if (u.role === 'admin') throw new ForbiddenException({ code: 'cannot_modify_admin' });
    return u as { role: StaffRole; status: string };
  }

  private async audit(
    tx: TransactionSql,
    actorId: string,
    action: string,
    entityId: string,
    data: Record<string, unknown> = {},
  ) {
    await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
      VALUES (${actorId}, ${action}, 'user', ${entityId}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
  }
}
