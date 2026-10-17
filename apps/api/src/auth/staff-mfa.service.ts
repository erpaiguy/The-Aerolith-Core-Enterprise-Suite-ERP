// Two-factor sign-in for staff (docs/wave8-plan.md step 8g.1). Any user may set up an authenticator app; when the
// company requires it, admins and everyone who may post to the books must, and until they do their session can do
// nothing but set it up (the `mfa` claim, checked by the tenant guard). The company's own admin signs in through the
// control plane, which always asks for a code, so is not asked again here.
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open, seal } from '../crypto/secretbox.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import type { TenantClaims } from './auth.service.js';
import { PermissionsService } from './permissions.js';
import {
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp.js';

export interface StaffMfaRow {
  id: string;
  username: string;
  role: 'admin' | 'manager' | 'worker';
  owner_account_id?: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
  mfa_enabled_at: Date | null;
}

@Injectable()
export class StaffMfaService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  async policy(db: Sql) {
    const [p] = await db<
      { require_mfa: boolean }[]
    >`SELECT require_mfa FROM platform.security_setting`;
    return { requireMfa: p?.require_mfa ?? false };
  }

  /** Whether this user must set up two-factor sign-in before doing anything else. */
  async mustEnroll(db: Sql, tenantId: string, user: StaffMfaRow) {
    if (user.mfa_enabled_at || user.owner_account_id) return false;
    if (!(await this.policy(db)).requireMfa) return false;
    if (user.role === 'admin') return true;
    return this.permissions.can(
      {
        v: 1,
        kind: 'tenant',
        ten: tenantId,
        sub: user.id,
        role: user.role,
        sid: '',
        mcp: false,
        lic: 'active',
        iat: 0,
        exp: 0,
      } as TenantClaims,
      'accounts.post',
    );
  }

  /** A code from the app (not replayed) or one of the recovery codes (used up). */
  async verify(db: Sql, user: StaffMfaRow, code: string, now: Date) {
    const c = code.trim();
    if (looksLikeRecoveryCode(c)) {
      const [used] = await db`UPDATE platform."user"
        SET recovery_codes = array_remove(recovery_codes, ${hashRecoveryCode(c)})
        WHERE id = ${user.id} AND ${hashRecoveryCode(c)} = ANY(recovery_codes) RETURNING 1`;
      return Boolean(used);
    }
    if (!user.totp_secret) return false;
    const last = user.totp_last_step === null ? null : Number(user.totp_last_step);
    const step = verifyTotp(open(user.totp_secret, this.config.controlPlaneEncKey), c, now, last);
    if (step === null) return false;
    const [ok] = await db`UPDATE platform."user" SET totp_last_step = ${step}
      WHERE id = ${user.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING 1`;
    return Boolean(ok);
  }

  async status(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<{ enabled: Date | null; codes: number }[]>`
      SELECT mfa_enabled_at AS enabled, cardinality(recovery_codes) AS codes FROM platform."user" WHERE id = ${claims.sub}`;
    return {
      enabled: !!u?.enabled,
      enabledAt: u?.enabled ?? null,
      recoveryCodesLeft: u?.codes ?? 0,
      requiredNow: !!claims.mfa,
      ...(await this.policy(db)),
    };
  }

  async start(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<{ username: string; enabled: Date | null; owner: string | null }[]>`
      SELECT username, mfa_enabled_at AS enabled, owner_account_id AS owner FROM platform."user" WHERE id = ${claims.sub}`;
    if (!u || u.owner) throw new BadRequestException({ code: 'not_for_this_account' });
    if (u.enabled)
      throw new BadRequestException({ code: 'mfa_already_enabled', message: 'Already set up.' });
    const secret = newTotpSecret();
    await db`UPDATE platform."user" SET totp_pending_secret = ${seal(secret, this.config.controlPlaneEncKey)}
      WHERE id = ${claims.sub}`;
    return { secret, otpauthUri: otpauthUri(secret, u.username) };
  }

  /** The first code from the app turns it on; the ten recovery codes are shown once. */
  async confirm(claims: TenantClaims, code: string, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<{ pending: string | null; enabled: Date | null }[]>`
      SELECT totp_pending_secret AS pending, mfa_enabled_at AS enabled FROM platform."user" WHERE id = ${claims.sub}`;
    if (!u?.pending || u.enabled) throw new BadRequestException({ code: 'no_pending_enrollment' });
    const step = verifyTotp(
      open(u.pending, this.config.controlPlaneEncKey),
      code.trim(),
      now,
      null,
    );
    if (step === null)
      throw new BadRequestException({
        code: 'invalid_code',
        message: 'That code is not correct. Check the time on your phone.',
      });
    const { codes, hashes } = newRecoveryCodes();
    await db.begin(async (tx) => {
      await tx`UPDATE platform."user" SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
        totp_last_step = ${step}, mfa_enabled_at = ${now}, recovery_codes = ${hashes} WHERE id = ${claims.sub}`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'user.mfa_enabled', 'user', ${claims.sub}, '{}')`;
    });
    return { recoveryCodes: codes };
  }

  /** Turned off with a current code, unless the company requires it of this user. */
  async disable(claims: TenantClaims, code: string, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const [u] = await db<StaffMfaRow[]>`SELECT * FROM platform."user" WHERE id = ${claims.sub}`;
    if (!u?.mfa_enabled_at) throw new BadRequestException({ code: 'mfa_not_enabled' });
    if ((await this.policy(db)).requireMfa) {
      const required = u.role === 'admin' || (await this.permissions.can(claims, 'accounts.post'));
      if (required)
        throw new ForbiddenException({
          code: 'mfa_required_by_company',
          message: 'The company requires two-factor sign-in for you.',
        });
    }
    if (!(await this.verify(db, u, code, now)))
      throw new BadRequestException({ code: 'invalid_code', message: 'That code is not correct.' });
    await db.begin(async (tx) => {
      await tx`UPDATE platform."user" SET totp_secret = NULL, totp_last_step = NULL, mfa_enabled_at = NULL,
        recovery_codes = '{}' WHERE id = ${claims.sub}`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'user.mfa_disabled', 'user', ${claims.sub}, '{}')`;
    });
    return this.status(claims);
  }

  /** An admin turns the company's requirement on or off; it applies from each person's next sign-in. */
  async setPolicy(claims: TenantClaims, requireMfa: boolean) {
    if (claims.role !== 'admin') throw new ForbiddenException({ code: 'forbidden' });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO platform.security_setting (id, require_mfa, updated_by) VALUES (true, ${requireMfa}, ${claims.sub})
        ON CONFLICT (id) DO UPDATE SET require_mfa = EXCLUDED.require_mfa, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'security.require_mfa', 'security_setting', 'company', ${tx.json({ requireMfa })})`;
    });
    return this.policy(db);
  }

  /** Who has it and who still must: for the admin's users screen. */
  async overview(claims: TenantClaims) {
    if (claims.role !== 'admin') throw new ForbiddenException({ code: 'forbidden' });
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, username, display_name AS "displayName", role, mfa_enabled_at IS NOT NULL AS enabled
      FROM platform."user" WHERE status = 'active' AND owner_account_id IS NULL ORDER BY lower(username)`;
  }
}
