// Portal identities (docs/wave6-plan.md step 5): vendors, subcontractors and clients invited by staff, signed in
// with email and password, each tied to one party. They are never staff: their own table, sessions, cookie and token
// kind, which the staff guard refuses. Free of seats, within a fair-use cap per kind set on the licence.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { invalidCredentials, LOCK_AFTER_FAILURES, LOCK_MINUTES } from '../auth/mfa.service.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password.js';
import { PermissionsService } from '../auth/permissions.js';
import {
  ACCESS_TTL_SECONDS,
  hmacSecret,
  newRefreshToken,
  parseRefreshToken,
  signAccessToken,
  type AccessClaims,
} from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { featuresUnlocked, type LicenceState } from '../licensing/licence-rules.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  capCheck,
  INVITE_DAYS,
  partyFits,
  PORTAL_ABSOLUTE_MS,
  PORTAL_IDLE_MS,
  PORTAL_KINDS,
  type PortalKind,
} from './portal-rules.js';

export type PortalClaims = Extract<AccessClaims, { kind: 'portal' }>;

interface UserRow {
  id: string;
  party_id: string;
  kind: PortalKind;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'deactivated';
  password_hash: string | null;
  failed_logins: number;
  locked_until: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const inviteHmac = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class PortalAuthService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly licensing: LicensingService,
    private readonly permissions: PermissionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // --- staff: invite, resend, deactivate ---

  private async mayManage(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'portal.manage')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'You may not manage portal users.',
      });
  }

  async list(claims: TenantClaims) {
    await this.mayManage(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const lic = await this.licensing.tenantLicence(claims.ten);
    const users = await db`
      SELECT u.id, u.kind, u.email, u.name, u.status, p.id AS "partyId", p.name AS party,
        u.last_login_at AS "lastLoginAt", u.invite_expires_at AS "inviteExpiresAt", u.created_at AS "createdAt"
      FROM portal."user" u JOIN platform.party p ON p.id = u.party_id
      ORDER BY u.status = 'deactivated', p.name, u.name`;
    const counts = await this.inUse(db);
    return {
      cap: lic.portalCap,
      inUse: Object.fromEntries(PORTAL_KINDS.map((k) => [k, counts[k] ?? 0])),
      users,
    };
  }

  private async inUse(db: Sql | TransactionSql): Promise<Partial<Record<PortalKind, number>>> {
    const rows = await db<{ kind: PortalKind; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM portal."user" WHERE status <> 'deactivated' GROUP BY kind`;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  /** Returns the invite link's token once; only its hash is kept. */
  async invite(
    claims: TenantClaims,
    input: { partyId: string; kind: PortalKind; email: string; name: string },
  ) {
    await this.mayManage(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const lic = await this.licensing.tenantLicence(claims.ten);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    const id = await db.begin(async (tx) => {
      // One invitation at a time, so two cannot both take the last place under the cap.
      await tx`SELECT pg_advisory_xact_lock(hashtext('portal.invite'))`;
      const [party] = await tx<
        { name: string; is_vendor: boolean; is_subcontractor: boolean; is_client: boolean }[]
      >`
        SELECT name, is_vendor, is_subcontractor, is_client FROM platform.party
        WHERE id = ${input.partyId} AND deleted_at IS NULL`;
      if (!party) throw new NotFoundException({ code: 'party_not_found' });
      if (!partyFits(party, input.kind))
        throw new BadRequestException({
          code: 'party_not_that_kind',
          message: `${party.name} is not marked as a ${input.kind}.`,
        });
      const cap = capCheck((await this.inUse(tx))[input.kind] ?? 0, lic.portalCap);
      if (!cap.ok)
        throw new ConflictException({
          code: cap.reason,
          message: `The fair-use limit of ${lic.portalCap} ${input.kind} portal users is reached. Deactivate one, or ask for the limit to be raised.`,
        });
      const [taken] = await tx`
        SELECT 1 FROM portal."user" WHERE lower(email) = lower(${input.email})`;
      if (taken)
        throw new ConflictException({
          code: 'email_taken',
          message: 'This email already has a portal account.',
        });
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO portal."user" (party_id, kind, email, name, invite_hmac, invite_expires_at, invited_by)
        VALUES (${input.partyId}, ${input.kind}, ${input.email}, ${input.name}, ${inviteHmac(token)}, ${expires},
                ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'portal.invite', 'portal_user', u!.id, {
        partyId: input.partyId,
        kind: input.kind,
        email: input.email,
      });
      return u!.id;
    });
    return { id, token, expiresAt: expires };
  }

  /** A fresh link (the old one stops working). An active user gets one only to reset a forgotten password. */
  async resend(claims: TenantClaims, userId: string) {
    await this.mayManage(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await db.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        UPDATE portal."user" SET invite_hmac = ${inviteHmac(token)}, invite_expires_at = ${expires}
        WHERE id = ${userId} AND status <> 'deactivated' RETURNING id`;
      if (!u) throw new NotFoundException({ code: 'portal_user_not_found' });
      await audit(tx, claims.sub, 'portal.resend', 'portal_user', userId, {});
    });
    return { id: userId, token, expiresAt: expires };
  }

  async deactivate(claims: TenantClaims, userId: string) {
    await this.mayManage(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE portal."user" SET status = 'deactivated', invite_hmac = NULL, invite_expires_at = NULL
        WHERE id = ${userId} RETURNING id`;
      if (!u) throw new NotFoundException({ code: 'portal_user_not_found' });
      await tx`UPDATE portal.session SET revoked_at = now(), revoked_reason = 'deactivated'
        WHERE user_id = ${userId} AND revoked_at IS NULL`;
      await audit(tx, claims.sub, 'portal.deactivate', 'portal_user', userId, {});
    });
    return this.list(claims);
  }

  // --- the outside user ---

  private async tenantDb(tenantId: string): Promise<Sql> {
    if (!UUID.test(tenantId)) throw invalidCredentials();
    try {
      return await this.tenants.forTenant(tenantId);
    } catch (err) {
      if (err instanceof NotFoundException) throw invalidCredentials();
      throw err;
    }
  }

  private async liveLicence(tenantId: string): Promise<LicenceState> {
    const lic = await this.licensing.tenantLicence(tenantId);
    if (lic.state === 'revoked' || lic.state === 'suspended')
      throw new ForbiddenException({
        code: `licence_${lic.state}`,
        message: 'This portal is not available at the moment.',
      });
    return lic.state;
  }

  /** What the accept page shows before a password is chosen. */
  async invitation(tenantId: string, token: string) {
    const db = await this.tenantDb(tenantId);
    const u = await this.byInvite(db, token);
    const [p] = await db<
      { name: string }[]
    >`SELECT name FROM platform.party WHERE id = ${u.party_id}`;
    return { email: u.email, name: u.name, kind: u.kind, party: p?.name ?? '' };
  }

  private async byInvite(db: Sql, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new BadRequestException({ code: 'link_invalid', message: 'This link is not valid.' });
    const [u] = await db<UserRow[]>`
      SELECT * FROM portal."user" WHERE invite_hmac = ${inviteHmac(token)}
        AND invite_expires_at > now() AND status <> 'deactivated'`;
    if (!u)
      throw new BadRequestException({
        code: 'link_invalid',
        message: 'This link is invalid or has expired. Ask for a new one.',
      });
    return u;
  }

  /** Sets the password from an invite (or a resent link) and signs in. */
  async accept(tenantId: string, token: string, password: string, now = new Date()) {
    const db = await this.tenantDb(tenantId);
    const lic = await this.liveLicence(tenantId);
    const u = await this.byInvite(db, token);
    const policy = checkPasswordPolicy(password, u.email.split('@')[0]!);
    if (!policy.ok) throw new BadRequestException({ code: `password_${policy.reason}` });
    const hash = await hashPassword(password);
    await db.begin(async (tx) => {
      await tx`UPDATE portal."user" SET password_hash = ${hash}, status = 'active', invite_hmac = NULL,
          invite_expires_at = NULL, failed_logins = 0, locked_until = NULL
        WHERE id = ${u.id}`;
      // A reset link ends every other session.
      await tx`UPDATE portal.session SET revoked_at = now(), revoked_reason = 'password_set'
        WHERE user_id = ${u.id} AND revoked_at IS NULL`;
      await audit(tx, u.id, 'portal.accept', 'portal_user', u.id, {});
    });
    return this.session(db, tenantId, { ...u, status: 'active' }, lic, now);
  }

  async login(tenantId: string, email: string, password: string, now = new Date()) {
    const db = await this.tenantDb(tenantId);
    const [u] = await db<
      UserRow[]
    >`SELECT * FROM portal."user" WHERE lower(email) = lower(${email})`;
    const ok = await verifyPassword(u?.password_hash ?? null, password);
    if (!u || u.status !== 'active' || (u.locked_until !== null && u.locked_until > now))
      throw invalidCredentials();
    if (!ok) {
      await db`UPDATE portal."user" SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN (failed_logins + 1) % ${LOCK_AFTER_FAILURES} = 0
                            THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
        WHERE id = ${u.id}`;
      throw invalidCredentials();
    }
    const lic = await this.liveLicence(tenantId);
    await db`UPDATE portal."user" SET failed_logins = 0, locked_until = NULL, last_login_at = ${now}
      WHERE id = ${u.id}`;
    return this.session(db, tenantId, u, lic, now);
  }

  private async session(db: Sql, tenantId: string, u: UserRow, lic: LicenceState, now: Date) {
    const id = randomUUID();
    const refresh = newRefreshToken(tenantId, id);
    await db`INSERT INTO portal.session (id, user_id, refresh_hmac, idle_expires_at, absolute_expires_at)
      VALUES (${id}, ${u.id}, ${hmacSecret(refresh.secret, this.config.sessionKey)},
              ${new Date(now.getTime() + PORTAL_IDLE_MS)}, ${new Date(now.getTime() + PORTAL_ABSOLUTE_MS)})`;
    return {
      accessToken: this.accessToken(tenantId, u, id, lic, now),
      refreshToken: refresh.token,
      user: await this.describe(db, u),
      licence: { state: lic, featuresUnlocked: featuresUnlocked(lic) },
    };
  }

  private accessToken(tenantId: string, u: UserRow, sid: string, lic: LicenceState, now: Date) {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: PortalClaims = {
      v: 1,
      kind: 'portal',
      ten: tenantId,
      sub: u.id,
      party: u.party_id,
      pk: u.kind,
      sid,
      lic,
      iat,
      exp: iat + ACCESS_TTL_SECONDS,
    };
    return signAccessToken(claims, this.config.sessionKey);
  }

  private async describe(db: Sql, u: UserRow) {
    const [p] = await db<
      { name: string }[]
    >`SELECT name FROM platform.party WHERE id = ${u.party_id}`;
    return { id: u.id, name: u.name, email: u.email, kind: u.kind, party: p?.name ?? '' };
  }

  async refresh(tenantId: string, refreshToken: string, now = new Date()) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed || parsed.scope !== tenantId)
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    const db = await this.tenantDb(tenantId);
    const [s] = await db<
      (UserRow & {
        session_id: string;
        refresh_hmac: string;
        previous_hmac: string | null;
        revoked_at: Date | null;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      })[]
    >`
      SELECT u.*, s.id AS session_id, s.refresh_hmac, s.previous_hmac, s.revoked_at, s.idle_expires_at,
        s.absolute_expires_at
      FROM portal.session s JOIN portal."user" u ON u.id = s.user_id WHERE s.id = ${parsed.sessionId}`;
    if (!s || s.revoked_at) throw new UnauthorizedException({ code: 'session_revoked' });
    const presented = hmacSecret(parsed.secret, this.config.sessionKey);
    if (presented === s.previous_hmac) {
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
      await this.revoke(db, parsed.sessionId, 'deactivated');
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    const lic = await this.liveLicence(tenantId);
    const next = newRefreshToken(tenantId, parsed.sessionId);
    const [rotated] = await db`UPDATE portal.session SET previous_hmac = refresh_hmac,
        refresh_hmac = ${hmacSecret(next.secret, this.config.sessionKey)}, last_used_at = ${now},
        idle_expires_at = ${new Date(now.getTime() + PORTAL_IDLE_MS)}
      WHERE id = ${parsed.sessionId} AND refresh_hmac = ${presented} RETURNING 1`;
    if (!rotated) throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    return {
      accessToken: this.accessToken(tenantId, s, parsed.sessionId, lic, now),
      refreshToken: next.token,
      user: await this.describe(db, s),
      licence: { state: lic, featuresUnlocked: featuresUnlocked(lic) },
    };
  }

  async logout(claims: PortalClaims) {
    await this.revoke(await this.tenants.forTenant(claims.ten), claims.sid, 'logout');
  }

  /** The session behind a token is still live and its user active (checked on every portal request). */
  async live(claims: PortalClaims): Promise<boolean> {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db`
      SELECT 1 FROM portal.session s JOIN portal."user" u ON u.id = s.user_id
      WHERE s.id = ${claims.sid} AND s.revoked_at IS NULL AND u.status = 'active' AND u.id = ${claims.sub}`;
    return Boolean(s);
  }

  private async revoke(db: Sql, sessionId: string, reason: string) {
    await db`UPDATE portal.session SET revoked_at = now(), revoked_reason = ${reason}
      WHERE id = ${sessionId} AND revoked_at IS NULL`;
  }
}
