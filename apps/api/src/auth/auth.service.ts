// Tenant sign-in (docs/03-architecture.md §6):
//   Tenant admin: email + password + mandatory TOTP. Identity in the control plane; a linked user row in the tenant DB.
//   Staff: username + password. Identity in the tenant's own database.
// The tenant is always taken from the device's signed entitlement token (licence key activation), never from input.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { seal } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { featuresUnlocked, type LicenceState } from '../licensing/licence-rules.js';
import { LicensingService, tokenHmac } from '../licensing/licensing.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import {
  LOCK_AFTER_FAILURES,
  LOCK_MINUTES,
  MfaService,
  invalidCredentials,
  type IdentityRow,
} from './mfa.service.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password.js';
import { StaffMfaService } from './staff-mfa.service.js';
import {
  ACCESS_TTL_SECONDS,
  hmacSecret,
  newRefreshToken,
  parseRefreshToken,
  signAccessToken,
  type AccessClaims,
} from './tokens.js';

export type Client = 'browser' | 'desktop';
export type TenantClaims = Extract<AccessClaims, { kind: 'tenant' }>;

/** Idle timeouts decided in Phase 9: 30 minutes in a browser, 12 hours on the desktop. */
export const IDLE_MS: Record<Client, number> = { browser: 30 * 60_000, desktop: 12 * 3_600_000 };
const ABSOLUTE_MS = 30 * 86_400_000;
const RESET_LINK_MINUTES = 30;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'manager' | 'worker';
  status: 'active' | 'deactivated';
  password_hash: string | null;
  must_change_password: boolean;
  failed_logins: number;
  locked_until: Date | null;
  owner_account_id: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
  mfa_enabled_at: Date | null;
}

export type LoginResult =
  | {
      status: 'ok';
      accessToken: string;
      refreshToken: string;
      user: { id: string; username: string; displayName: string; role: string };
      mustChangePassword: boolean;
      /** Two-factor sign-in must be set up before anything else (step 8g.1). */
      mustSetUpMfa: boolean;
      licence: { state: LicenceState; featuresUnlocked: boolean };
    }
  | { status: 'mfa_required' }
  | { status: 'mfa_enrollment_required'; enrollmentToken: string };

const publicUser = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  role: u.role,
});

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantConnections,
    private readonly licensing: LicensingService,
    private readonly mfa: MfaService,
    private readonly staffMfa: StaffMfaService,
  ) {}

  async login(
    input: {
      entitlementToken: string;
      identifier: string;
      password: string;
      code?: string | undefined;
      client: Client;
    },
    now = new Date(),
  ): Promise<LoginResult> {
    const { tenantId } = this.licensing.deviceTenant(input.entitlementToken, now);
    const licence = await this.licensing.tenantLicence(tenantId, now);
    if (licence.state === 'revoked' || licence.state === 'suspended') {
      throw new ForbiddenException({ code: `licence_${licence.state}` });
    }
    return input.identifier.includes('@')
      ? this.adminLogin(tenantId, licence.state, input, now)
      : this.staffLogin(tenantId, licence.state, input, now);
  }

  private async adminLogin(
    tenantId: string,
    lic: LicenceState,
    input: { identifier: string; password: string; code?: string | undefined; client: Client },
    now: Date,
  ): Promise<LoginResult> {
    const [owner] = await this.sql<IdentityRow[]>`
      SELECT o.* FROM core.owner_account o JOIN core.tenant t ON t.owner_account_id = o.id
      WHERE t.id = ${tenantId} AND lower(o.email) = lower(${input.identifier}) AND o.status = 'active'`;
    const passwordOk = await verifyPassword(owner?.password_hash ?? null, input.password);
    if (!owner || this.mfa.isLocked(owner, now)) throw invalidCredentials();
    if (!passwordOk) {
      await this.mfa.registerFailure('owner_account', owner.id);
      throw invalidCredentials();
    }
    if (!owner.mfa_enabled_at) {
      return {
        status: 'mfa_enrollment_required',
        enrollmentToken: this.mfa.enrollmentToken('admin', owner.id, tenantId, now),
      };
    }
    if (!input.code) return { status: 'mfa_required' };
    if (!(await this.mfa.verifySecondFactor('owner_account', owner, input.code, now))) {
      await this.mfa.registerFailure('owner_account', owner.id);
      throw invalidCredentials();
    }
    await this.mfa.registerSuccess('owner_account', owner.id);

    const db = await this.tenants.forTenant(tenantId);
    const [user] = await db<UserRow[]>`
      INSERT INTO platform."user" (username, display_name, role, owner_account_id, must_change_password, last_login_at)
      VALUES (lower(${owner.email}), ${owner.email}, 'admin', ${owner.id}, false, ${now})
      ON CONFLICT (owner_account_id) DO UPDATE SET last_login_at = EXCLUDED.last_login_at, status = 'active'
      RETURNING *`;
    return this.createSession(db, tenantId, user!, input.client, lic, now);
  }

  private async staffLogin(
    tenantId: string,
    lic: LicenceState,
    input: { identifier: string; password: string; code?: string | undefined; client: Client },
    now: Date,
  ): Promise<LoginResult> {
    const db = await this.tenants.forTenant(tenantId);
    const [user] = await db<UserRow[]>`
      SELECT * FROM platform."user" WHERE lower(username) = lower(${input.identifier}) AND owner_account_id IS NULL`;
    const passwordOk = await verifyPassword(user?.password_hash ?? null, input.password);
    if (
      !user ||
      user.status !== 'active' ||
      (user.locked_until !== null && user.locked_until > now)
    )
      throw invalidCredentials();
    if (!passwordOk) {
      await db`UPDATE platform."user" SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN (failed_logins + 1) % ${LOCK_AFTER_FAILURES} = 0
                            THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
        WHERE id = ${user.id}`;
      throw invalidCredentials();
    }
    // Two-factor sign-in, once the user has set it up (step 8g.1).
    if (user.mfa_enabled_at) {
      if (!input.code) return { status: 'mfa_required' };
      if (!(await this.staffMfa.verify(db, user, input.code, now))) {
        await db`UPDATE platform."user" SET failed_logins = failed_logins + 1,
          locked_until = CASE WHEN (failed_logins + 1) % ${LOCK_AFTER_FAILURES} = 0
                              THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
          WHERE id = ${user.id}`;
        throw invalidCredentials();
      }
    }
    await db`UPDATE platform."user" SET failed_logins = 0, locked_until = NULL, last_login_at = ${now} WHERE id = ${user.id}`;
    return this.createSession(db, tenantId, user, input.client, lic, now);
  }

  async refresh(refreshToken: string, now = new Date()) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed || parsed.scope === 'op')
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    const tenantId = parsed.scope;
    const db = await this.tenants.forTenant(tenantId);
    const [s] = await db<
      (UserRow & {
        session_id: string;
        client: Client;
        refresh_hmac: string;
        previous_hmac: string | null;
        revoked_at: Date | null;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      })[]
    >`
      SELECT u.*, s.id AS session_id, s.client, s.refresh_hmac, s.previous_hmac, s.revoked_at, s.idle_expires_at, s.absolute_expires_at
      FROM platform.session s JOIN platform."user" u ON u.id = s.user_id WHERE s.id = ${parsed.sessionId}`;
    if (!s || s.revoked_at) throw new UnauthorizedException({ code: 'session_revoked' });
    const presented = hmacSecret(parsed.secret, this.config.sessionKey);
    if (presented === s.previous_hmac) {
      // An old refresh token came back: someone else holds a copy. End the session for both.
      await this.revoke(db, parsed.sessionId, 'refresh_reuse');
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    if (presented !== s.refresh_hmac)
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    if (s.idle_expires_at <= now || s.absolute_expires_at <= now) {
      await this.revoke(db, parsed.sessionId, 'expired');
      throw new UnauthorizedException({ code: 'session_expired' });
    }
    if (s.status !== 'active') {
      await this.revoke(db, parsed.sessionId, 'user_deactivated');
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    const licence = await this.licensing.tenantLicence(tenantId, now);
    if (licence.state === 'revoked' || licence.state === 'suspended') {
      await this.revoke(db, parsed.sessionId, `licence_${licence.state}`);
      throw new ForbiddenException({ code: `licence_${licence.state}` });
    }
    const next = newRefreshToken(tenantId, parsed.sessionId);
    const [rotated] = await db`UPDATE platform.session SET previous_hmac = refresh_hmac,
        refresh_hmac = ${hmacSecret(next.secret, this.config.sessionKey)}, last_used_at = ${now},
        idle_expires_at = ${new Date(now.getTime() + IDLE_MS[s.client])}
      WHERE id = ${parsed.sessionId} AND refresh_hmac = ${presented} RETURNING 1`;
    if (!rotated) throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    const mustSetUpMfa = await this.staffMfa.mustEnroll(db, tenantId, s);
    return {
      accessToken: this.accessToken(
        tenantId,
        s,
        parsed.sessionId,
        licence.state,
        now,
        mustSetUpMfa,
      ),
      refreshToken: next.token,
      mustChangePassword: s.must_change_password,
      mustSetUpMfa,
      licence: { state: licence.state, featuresUnlocked: featuresUnlocked(licence.state) },
    };
  }

  async logout(claims: TenantClaims): Promise<void> {
    await this.revoke(await this.tenants.forTenant(claims.ten), claims.sid, 'logout');
  }

  async me(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const [user] = await db<UserRow[]>`SELECT * FROM platform."user" WHERE id = ${claims.sub}`;
    if (!user) throw new UnauthorizedException({ code: 'session_revoked' });
    return {
      ...publicUser(user),
      mustChangePassword: user.must_change_password,
      mustSetUpMfa: !!claims.mfa,
      licence: { state: claims.lic, featuresUnlocked: featuresUnlocked(claims.lic) },
    };
  }

  /** Any signed-in user. Required before anything else when an admin issued a temporary password. */
  async changePassword(
    claims: TenantClaims,
    current: string,
    next: string,
    now = new Date(),
  ): Promise<{ accessToken: string }> {
    const db = await this.tenants.forTenant(claims.ten);
    const [user] = await db<
      (UserRow & { owner_account_id: string | null })[]
    >`SELECT * FROM platform."user" WHERE id = ${claims.sub}`;
    if (!user) throw new UnauthorizedException({ code: 'session_revoked' });

    if (user.owner_account_id) {
      const [owner] = await this.sql<{ email: string; password_hash: string | null }[]>`
        SELECT email, password_hash FROM core.owner_account WHERE id = ${user.owner_account_id}`;
      if (!owner || !(await verifyPassword(owner.password_hash, current)))
        throw invalidCredentials();
      await this.assertNewPassword(next, owner.email, owner.password_hash);
      await this
        .sql`UPDATE core.owner_account SET password_hash = ${await hashPassword(next)} WHERE id = ${user.owner_account_id}`;
    } else {
      if (!(await verifyPassword(user.password_hash, current))) throw invalidCredentials();
      await this.assertNewPassword(next, user.username, user.password_hash);
      await db`UPDATE platform."user" SET password_hash = ${await hashPassword(next)}, must_change_password = false,
        updated_at = now() WHERE id = ${user.id}`;
    }
    await db`UPDATE platform.session SET revoked_at = now(), revoked_reason = 'password_changed'
      WHERE user_id = ${user.id} AND id <> ${claims.sid} AND revoked_at IS NULL`;
    await this.audit(db, user.id, 'user.password_changed', user.id);
    return {
      accessToken: this.accessToken(
        claims.ten,
        { ...user, must_change_password: false },
        claims.sid,
        claims.lic,
        now,
      ),
    };
  }

  /**
   * Staff "forgot password": goes to the tenant admin's Pending inbox (no email needed). The response never reveals
   * whether the username exists, and repeated requests collapse into one.
   */
  async requestPasswordReset(
    entitlementToken: string,
    username: string,
    deviceLabel: string | null,
  ): Promise<void> {
    const { tenantId } = this.licensing.deviceTenant(entitlementToken);
    const db = await this.tenants.forTenant(tenantId);
    const [user] = await db<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM platform."user"
      WHERE lower(username) = lower(${username}) AND owner_account_id IS NULL AND status = 'active'`;
    if (!user) return;
    await db.begin(async (tx) => {
      const [created] =
        await tx`INSERT INTO platform.password_reset_request (user_id, device_label) VALUES (${user.id}, ${deviceLabel})
        ON CONFLICT (user_id) WHERE status = 'pending' DO UPDATE SET requested_at = now(), device_label = EXCLUDED.device_label
        RETURNING (xmax = 0) AS inserted`;
      if (created?.inserted) {
        await tx`INSERT INTO platform.notification (user_id, kind, title, body, link)
          SELECT id, 'password_reset_request', 'Password reset requested', ${`${user.display_name} has asked for a new password.`},
                 '/admin/password-resets'
          FROM platform."user" WHERE role = 'admin' AND status = 'active'`;
      }
    });
  }

  /** Tenant admin "forgot password": a reset link to the registered email, valid for 30 minutes. */
  async adminForgotPassword(email: string, now = new Date()): Promise<void> {
    const [owner] = await this.sql<{ id: string; email: string }[]>`
      SELECT id, email FROM core.owner_account WHERE lower(email) = lower(${email}) AND status = 'active'`;
    if (!owner) return;
    const token = randomBytes(32).toString('base64url');
    const url = new URL('/account/reset-password', this.config.websiteUrl);
    url.searchParams.set('token', token);
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO core.owner_password_token (owner_account_id, purpose, token_hmac, expires_at)
        VALUES (${owner.id}, 'reset', ${tokenHmac(token, this.config.licenceKeyPepper)},
                ${new Date(now.getTime() + RESET_LINK_MINUTES * 60_000)})`;
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        VALUES (${owner.email}, 'admin_password_reset', ${tx.json({ link: seal(url.toString(), this.config.controlPlaneEncKey) })})`;
    });
  }

  /** Completes a setup or reset link. MFA is still required at the next sign-in. */
  async adminSetPassword(token: string, newPassword: string): Promise<void> {
    const [row] = await this.sql<
      { owner_account_id: string; email: string; password_hash: string | null }[]
    >`
      SELECT t.owner_account_id, o.email, o.password_hash FROM core.owner_password_token t
      JOIN core.owner_account o ON o.id = t.owner_account_id
      WHERE t.token_hmac = ${tokenHmac(token, this.config.licenceKeyPepper)} AND t.used_at IS NULL AND t.expires_at > now()`;
    if (!row)
      throw new BadRequestException({
        code: 'link_invalid',
        message: 'This link is invalid or has expired.',
      });
    await this.assertNewPassword(newPassword, row.email, row.password_hash);
    const tenants = await this.sql.begin(async (tx) => {
      await tx`UPDATE core.owner_account SET password_hash = ${await hashPassword(newPassword)}, failed_logins = 0, locked_until = NULL
        WHERE id = ${row.owner_account_id}`;
      await tx`UPDATE core.owner_password_token SET used_at = now() WHERE owner_account_id = ${row.owner_account_id} AND used_at IS NULL`;
      await tx`INSERT INTO core.email_outbox (to_email, template, data) VALUES (${row.email}, 'admin_password_changed', '{}')`;
      return tx<{ tenant_id: string }[]>`
        SELECT t.id AS tenant_id FROM core.tenant t JOIN core.tenant_db d ON d.tenant_id = t.id
        WHERE t.owner_account_id = ${row.owner_account_id} AND d.status = 'ready'`;
    });
    // Sign the admin out everywhere.
    for (const { tenant_id } of tenants) {
      const db = await this.tenants.forTenant(tenant_id);
      await db`UPDATE platform.session s SET revoked_at = now(), revoked_reason = 'password_reset'
        FROM platform."user" u WHERE u.id = s.user_id AND u.owner_account_id = ${row.owner_account_id} AND s.revoked_at IS NULL`;
    }
  }

  // --- internals ---

  private async assertNewPassword(
    next: string,
    username: string,
    currentHash: string | null,
  ): Promise<void> {
    const policy = checkPasswordPolicy(next, username);
    if (!policy.ok) throw new BadRequestException({ code: `password_${policy.reason}` });
    if (currentHash && (await verifyPassword(currentHash, next)))
      throw new BadRequestException({ code: 'password_unchanged' });
  }

  private async createSession(
    db: Sql,
    tenantId: string,
    user: UserRow,
    client: Client,
    lic: LicenceState,
    now: Date,
  ): Promise<LoginResult> {
    const id = randomUUID();
    const refresh = newRefreshToken(tenantId, id);
    await db`INSERT INTO platform.session (id, user_id, client, refresh_hmac, idle_expires_at, absolute_expires_at)
      VALUES (${id}, ${user.id}, ${client}, ${hmacSecret(refresh.secret, this.config.sessionKey)},
              ${new Date(now.getTime() + IDLE_MS[client])}, ${new Date(now.getTime() + ABSOLUTE_MS)})`;
    await this.audit(db, user.id, 'user.login', user.id, { client });
    const mustSetUpMfa = await this.staffMfa.mustEnroll(db, tenantId, user);
    return {
      status: 'ok',
      accessToken: this.accessToken(tenantId, user, id, lic, now, mustSetUpMfa),
      mustSetUpMfa,
      refreshToken: refresh.token,
      user: publicUser(user),
      mustChangePassword: user.must_change_password,
      licence: { state: lic, featuresUnlocked: featuresUnlocked(lic) },
    };
  }

  private accessToken(
    tenantId: string,
    user: Pick<UserRow, 'id' | 'role' | 'must_change_password'>,
    sessionId: string,
    lic: LicenceState,
    now: Date,
    mustSetUpMfa = false,
  ): string {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: TenantClaims = {
      v: 1,
      kind: 'tenant',
      ten: tenantId,
      sub: user.id,
      role: user.role,
      sid: sessionId,
      mcp: user.must_change_password,
      ...(mustSetUpMfa ? { mfa: true } : {}),
      lic,
      iat,
      exp: iat + ACCESS_TTL_SECONDS,
    };
    return signAccessToken(claims, this.config.sessionKey);
  }

  private async revoke(db: Sql, sessionId: string, reason: string): Promise<void> {
    await db`UPDATE platform.session SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${sessionId} AND revoked_at IS NULL`;
  }

  private async audit(
    db: Sql,
    actorId: string,
    action: string,
    entityId: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await db`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
      VALUES (${actorId}, ${action}, 'user', ${entityId}, ${db.json(JSON.parse(JSON.stringify(data)))})`;
  }
}
