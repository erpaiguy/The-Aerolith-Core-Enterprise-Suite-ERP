// Platform operators: the owner console's own accounts (docs/09-security.md §7). Email + password + mandatory TOTP.
// Replaces the interim owner API token from step 3.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { MfaService, invalidCredentials, type IdentityRow } from './mfa.service.js';
import {
  checkPasswordPolicy,
  hashPassword,
  temporaryPassword,
  verifyPassword,
} from './password.js';
import {
  ACCESS_TTL_SECONDS,
  hmacSecret,
  newRefreshToken,
  parseRefreshToken,
  signAccessToken,
  type AccessClaims,
} from './tokens.js';

const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;

export type OperatorRole = 'owner' | 'support' | 'read_only';

interface OperatorRow extends IdentityRow {
  role: OperatorRole;
  status: 'active' | 'disabled';
  must_change_password: boolean;
}

export type OperatorLoginResult =
  | { status: 'ok'; accessToken: string; refreshToken: string; mustChangePassword: boolean }
  | { status: 'mfa_required' }
  | { status: 'mfa_enrollment_required'; enrollmentToken: string };

@Injectable()
export class OperatorAuthService {
  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mfa: MfaService,
  ) {}

  /** CLI only. Returns a one-time password that must be changed at first sign-in. */
  async createOperator(
    email: string,
    displayName: string,
    role: OperatorRole,
  ): Promise<{ id: string; temporaryPassword: string }> {
    const password = temporaryPassword();
    try {
      const [row] = await this.sql<{ id: string }[]>`
        INSERT INTO core.operator (email, display_name, role, password_hash)
        VALUES (${email}, ${displayName}, ${role}, ${await hashPassword(password)}) RETURNING id`;
      return { id: row!.id, temporaryPassword: password };
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictException({ code: 'operator_exists' });
      throw err;
    }
  }

  /**
   * CLI only (break-glass, e.g. lost phone and recovery codes): new one-time password, authenticator and recovery
   * codes cleared, every session signed out. The next sign-in goes through MFA enrolment again. Access to the server's
   * command line is the root of trust here, which is why there is no HTTP route for this.
   */
  async resetOperator(email: string): Promise<{ temporaryPassword: string }> {
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    return this.sql.begin(async (tx) => {
      const [op] = await tx<{ id: string }[]>`
        UPDATE core.operator SET password_hash = ${hash}, must_change_password = true, totp_secret = NULL,
          totp_pending_secret = NULL, totp_last_step = NULL, mfa_enabled_at = NULL, recovery_codes = '{}',
          failed_logins = 0, locked_until = NULL, status = 'active'
        WHERE lower(email) = lower(${email}) RETURNING id`;
      if (!op) throw new NotFoundException({ code: 'operator_not_found' });
      await tx`UPDATE core.operator_session SET revoked_at = now(), revoked_reason = 'operator_reset'
        WHERE operator_id = ${op.id} AND revoked_at IS NULL`;
      await tx`INSERT INTO core.owner_audit (action, target, data)
        VALUES ('operator.reset', ${`operator:${op.id}`}, ${tx.json({ actor: 'cli' })})`;
      return { temporaryPassword: password };
    });
  }

  async login(
    email: string,
    password: string,
    code: string | undefined,
    now = new Date(),
  ): Promise<OperatorLoginResult> {
    const [op] = await this.sql<
      OperatorRow[]
    >`SELECT * FROM core.operator WHERE lower(email) = lower(${email})`;
    const passwordOk = await verifyPassword(op?.password_hash ?? null, password);
    if (!op || op.status !== 'active' || this.mfa.isLocked(op, now)) throw invalidCredentials();
    if (!passwordOk) {
      await this.mfa.registerFailure('operator', op.id);
      throw invalidCredentials();
    }
    if (!op.mfa_enabled_at)
      return {
        status: 'mfa_enrollment_required',
        enrollmentToken: this.mfa.enrollmentToken('operator', op.id, undefined, now),
      };
    if (!code) return { status: 'mfa_required' };
    if (!(await this.mfa.verifySecondFactor('operator', op, code, now))) {
      await this.mfa.registerFailure('operator', op.id);
      throw invalidCredentials();
    }
    await this.mfa.registerSuccess('operator', op.id);
    return this.createSession(op, now);
  }

  async refresh(refreshToken: string, now = new Date()) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed || parsed.scope !== 'op')
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    const [s] = await this.sql<
      {
        operator_id: string;
        refresh_hmac: string;
        previous_hmac: string | null;
        revoked_at: Date | null;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      }[]
    >`
      SELECT operator_id, refresh_hmac, previous_hmac, revoked_at, idle_expires_at, absolute_expires_at
      FROM core.operator_session WHERE id = ${parsed.sessionId}`;
    if (!s || s.revoked_at) throw new UnauthorizedException({ code: 'session_revoked' });
    const presented = hmacSecret(parsed.secret, this.config.sessionKey);
    if (presented === s.previous_hmac) {
      await this.revoke(parsed.sessionId, 'refresh_reuse');
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    if (presented !== s.refresh_hmac)
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    if (s.idle_expires_at <= now || s.absolute_expires_at <= now) {
      await this.revoke(parsed.sessionId, 'expired');
      throw new UnauthorizedException({ code: 'session_expired' });
    }
    const [op] = await this.sql<
      OperatorRow[]
    >`SELECT * FROM core.operator WHERE id = ${s.operator_id}`;
    if (!op || op.status !== 'active') {
      await this.revoke(parsed.sessionId, 'operator_disabled');
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    const next = newRefreshToken('op', parsed.sessionId);
    const [rotated] = await this.sql`UPDATE core.operator_session SET previous_hmac = refresh_hmac,
        refresh_hmac = ${hmacSecret(next.secret, this.config.sessionKey)}, last_used_at = ${now},
        idle_expires_at = ${new Date(now.getTime() + IDLE_MINUTES * 60_000)}
      WHERE id = ${parsed.sessionId} AND refresh_hmac = ${presented} RETURNING 1`;
    if (!rotated) throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    return {
      accessToken: this.accessToken(op, parsed.sessionId, now),
      refreshToken: next.token,
      mustChangePassword: op.must_change_password,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.revoke(sessionId, 'logout');
  }

  async changePassword(
    operatorId: string,
    sessionId: string,
    current: string,
    next: string,
    now = new Date(),
  ) {
    const [op] = await this.sql<
      OperatorRow[]
    >`SELECT * FROM core.operator WHERE id = ${operatorId}`;
    if (!op || !(await verifyPassword(op.password_hash, current))) throw invalidCredentials();
    const policy = checkPasswordPolicy(next, op.email);
    if (!policy.ok) throw new BadRequestException({ code: `password_${policy.reason}` });
    if (await verifyPassword(op.password_hash, next))
      throw new BadRequestException({ code: 'password_unchanged' });
    await this
      .sql`UPDATE core.operator SET password_hash = ${await hashPassword(next)}, must_change_password = false WHERE id = ${operatorId}`;
    await this
      .sql`UPDATE core.operator_session SET revoked_at = now(), revoked_reason = 'password_changed'
      WHERE operator_id = ${operatorId} AND id <> ${sessionId} AND revoked_at IS NULL`;
    return {
      accessToken: this.accessToken({ ...op, must_change_password: false }, sessionId, now),
    };
  }

  private async createSession(op: OperatorRow, now: Date): Promise<OperatorLoginResult> {
    const id = randomUUID();
    const refresh = newRefreshToken('op', id);
    await this
      .sql`INSERT INTO core.operator_session (id, operator_id, refresh_hmac, idle_expires_at, absolute_expires_at)
      VALUES (${id}, ${op.id}, ${hmacSecret(refresh.secret, this.config.sessionKey)},
              ${new Date(now.getTime() + IDLE_MINUTES * 60_000)}, ${new Date(now.getTime() + ABSOLUTE_HOURS * 3_600_000)})`;
    return {
      status: 'ok',
      accessToken: this.accessToken(op, id, now),
      refreshToken: refresh.token,
      mustChangePassword: op.must_change_password,
    };
  }

  private accessToken(
    op: Pick<OperatorRow, 'id' | 'role' | 'must_change_password'>,
    sessionId: string,
    now: Date,
  ): string {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: AccessClaims = {
      v: 1,
      kind: 'operator',
      sub: op.id,
      role: op.role,
      sid: sessionId,
      mcp: op.must_change_password,
      iat,
      exp: iat + ACCESS_TTL_SECONDS,
    };
    return signAccessToken(claims, this.config.sessionKey);
  }

  private async revoke(sessionId: string, reason: string): Promise<void> {
    await this.sql`UPDATE core.operator_session SET revoked_at = now(), revoked_reason = ${reason}
      WHERE id = ${sessionId} AND revoked_at IS NULL`;
  }
}
