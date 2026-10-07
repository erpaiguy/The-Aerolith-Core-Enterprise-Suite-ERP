// Mandatory TOTP for tenant admins and platform operators (docs/09-security.md §7), plus lockout bookkeeping for
// the two control-plane identity tables. Both tables share the same column names.
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open, seal } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import {
  ACCESS_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from './tokens.js';
import {
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp.js';

export type IdentityTable = 'owner_account' | 'operator';
const TABLE: Record<'admin' | 'operator', IdentityTable> = {
  admin: 'owner_account',
  operator: 'operator',
};

export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MINUTES = 15;
const ENROLL_TTL_SECONDS = 10 * 60;

export interface IdentityRow {
  id: string;
  email: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
  mfa_enabled_at: Date | null;
  recovery_codes: string[];
  failed_logins: number;
  locked_until: Date | null;
}

export const invalidCredentials = () =>
  new UnauthorizedException({ code: 'invalid_credentials', message: 'Incorrect sign-in details.' });

@Injectable()
export class MfaService {
  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Table name as a fixed SQL fragment (never built from input). */
  private tbl(table: IdentityTable) {
    return table === 'operator' ? this.sql`core.operator` : this.sql`core.owner_account`;
  }

  isLocked(row: { locked_until: Date | null }, now: Date): boolean {
    return row.locked_until !== null && row.locked_until > now;
  }

  async registerFailure(table: IdentityTable, id: string): Promise<void> {
    await this.sql`UPDATE ${this.tbl(table)} SET failed_logins = failed_logins + 1,
      locked_until = CASE WHEN (failed_logins + 1) % ${LOCK_AFTER_FAILURES} = 0
                          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
      WHERE id = ${id}`;
  }

  async registerSuccess(table: IdentityTable, id: string): Promise<void> {
    await this
      .sql`UPDATE ${this.tbl(table)} SET failed_logins = 0, locked_until = NULL WHERE id = ${id}`;
  }

  /** Short-lived token that only allows MFA enrolment, issued after a correct password. */
  enrollmentToken(
    who: 'admin' | 'operator',
    subject: string,
    tenantId: string | undefined,
    now: Date,
  ): string {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: AccessClaims = {
      v: 1,
      kind: 'enroll',
      who,
      sub: subject,
      iat,
      exp: iat + ENROLL_TTL_SECONDS,
      ...(tenantId ? { ten: tenantId } : {}),
    };
    return signAccessToken(claims, this.config.sessionKey);
  }

  private enrollClaims(token: string, now: Date): Extract<AccessClaims, { kind: 'enroll' }> {
    const claims = verifyAccessToken(
      token,
      this.config.sessionKey,
      Math.floor(now.getTime() / 1000),
    );
    if (!claims || claims.kind !== 'enroll')
      throw new UnauthorizedException({ code: 'enrollment_token_invalid' });
    return claims;
  }

  async startEnrollment(
    token: string,
    now = new Date(),
  ): Promise<{ secret: string; otpauthUri: string }> {
    const claims = this.enrollClaims(token, now);
    const table = TABLE[claims.who];
    const [row] = await this.sql<{ email: string; mfa_enabled_at: Date | null }[]>`
      SELECT email, mfa_enabled_at FROM ${this.tbl(table)} WHERE id = ${claims.sub}`;
    if (!row) throw new UnauthorizedException({ code: 'enrollment_token_invalid' });
    if (row.mfa_enabled_at) throw new BadRequestException({ code: 'mfa_already_enabled' });
    const secret = newTotpSecret();
    await this
      .sql`UPDATE ${this.tbl(table)} SET totp_pending_secret = ${seal(secret, this.config.controlPlaneEncKey)}
      WHERE id = ${claims.sub}`;
    return { secret, otpauthUri: otpauthUri(secret, row.email) };
  }

  /** Confirms the authenticator app with one code and returns the ten recovery codes (shown once). */
  async confirmEnrollment(
    token: string,
    code: string,
    now = new Date(),
  ): Promise<{ recoveryCodes: string[] }> {
    const claims = this.enrollClaims(token, now);
    const table = TABLE[claims.who];
    const [row] = await this.sql<
      { totp_pending_secret: string | null; mfa_enabled_at: Date | null }[]
    >`
      SELECT totp_pending_secret, mfa_enabled_at FROM ${this.tbl(table)} WHERE id = ${claims.sub}`;
    if (!row?.totp_pending_secret || row.mfa_enabled_at)
      throw new BadRequestException({ code: 'no_pending_enrollment' });
    const secret = open(row.totp_pending_secret, this.config.controlPlaneEncKey);
    const step = verifyTotp(secret, code.trim(), now, null);
    if (step === null)
      throw new BadRequestException({
        code: 'invalid_code',
        message: 'That code is not correct. Check the time on your phone.',
      });
    const { codes, hashes } = newRecoveryCodes();
    await this
      .sql`UPDATE ${this.tbl(table)} SET totp_secret = ${row.totp_pending_secret}, totp_pending_secret = NULL,
      totp_last_step = ${step}, mfa_enabled_at = ${now}, recovery_codes = ${hashes} WHERE id = ${claims.sub}`;
    return { recoveryCodes: codes };
  }

  /** Verifies a TOTP code (with replay protection) or consumes a recovery code. */
  async verifySecondFactor(
    table: IdentityTable,
    row: IdentityRow,
    code: string,
    now: Date,
  ): Promise<boolean> {
    if (looksLikeRecoveryCode(code)) {
      const [used] = await this.sql`UPDATE ${this.tbl(table)}
        SET recovery_codes = array_remove(recovery_codes, ${hashRecoveryCode(code)})
        WHERE id = ${row.id} AND ${hashRecoveryCode(code)} = ANY(recovery_codes) RETURNING 1`;
      return Boolean(used);
    }
    if (!row.totp_secret) return false;
    const last = row.totp_last_step === null ? null : Number(row.totp_last_step);
    const step = verifyTotp(
      open(row.totp_secret, this.config.controlPlaneEncKey),
      code.trim(),
      now,
      last,
    );
    if (step === null) return false;
    // Conditional update so two concurrent logins can't both use the same code.
    const [ok] = await this.sql`UPDATE ${this.tbl(table)} SET totp_last_step = ${step}
      WHERE id = ${row.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING 1`;
    return Boolean(ok);
  }
}

export { ACCESS_TTL_SECONDS };
