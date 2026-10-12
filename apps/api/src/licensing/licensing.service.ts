import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, type KeyObject } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open, seal } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import {
  publicKeyOf,
  signEntitlement,
  verifyEntitlement,
  type Entitlement,
} from './entitlement.js';
import {
  generateLicenceKey,
  licenceKeyHmac,
  licenceKeyLast4,
  parseLicenceKey,
} from './licence-key.js';
import {
  addDays,
  featuresUnlocked,
  licenceState,
  validateTrialChange,
  type LicenceState,
  type LicenceStatus,
  type Role,
} from './licence-rules.js';

interface LicenceRow {
  id: string;
  tenant_id: string;
  tier_id: string;
  kind: 'trial' | 'paid' | 'self_hosted';
  status: LicenceStatus;
  key_last4: string;
  seat_cap: number;
  portal_cap: number;
  max_devices: number;
  starts_at: Date;
  ends_at: Date;
  grace_days: number;
}

export interface IssuedTrial {
  tenantId: string;
  licenceId: string;
  licenceKey: string;
  endsAt: Date;
}

export interface ActivationResult {
  token: string;
  entitlement: Entitlement;
  featuresUnlocked: boolean;
}

export const tokenHmac = (token: string, pepper: Buffer): string =>
  createHmac('sha256', pepper).update(token).digest('hex');

export interface TenantLicence {
  licenceId: string;
  tierId: string;
  seatCap: number;
  roleCaps: Partial<Record<Role, number>> | null;
  /** Portal users per kind (fair use; they are never seats). */
  portalCap: number;
  state: LicenceState;
}

const hashDevice = (deviceId: string): string =>
  createHash('sha256').update(deviceId).digest('hex');
const DAY_MS = 86_400_000;

@Injectable()
export class LicensingService {
  private readonly publicKey: KeyObject;

  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.publicKey = publicKeyOf(config.entitlementPrivateKey);
  }

  /** Website signup / owner console: owner account + tenant + 120-day trial licence + queued key email. */
  async createTenantWithTrial(
    email: string,
    tenantName: string,
    actor: string,
    now = new Date(),
  ): Promise<IssuedTrial> {
    const key = generateLicenceKey();
    const parsed = parseLicenceKey(key);
    if (!parsed.ok) throw new Error('generated an invalid licence key');
    const endsAt = addDays(now, this.config.trialDays);

    return this.sql.begin(async (tx) => {
      const [owner] = await tx<{ id: string }[]>`
        INSERT INTO core.owner_account (email) VALUES (${email})
        ON CONFLICT ((lower(email))) DO UPDATE SET email = core.owner_account.email
        RETURNING id`;
      const [existing] = await tx`
        SELECT 1 FROM core.licence l JOIN core.tenant t ON t.id = l.tenant_id
        WHERE t.owner_account_id = ${owner!.id} AND l.kind = 'trial' LIMIT 1`;
      if (existing)
        throw new ConflictException({
          code: 'trial_already_used',
          message: 'This email already has a trial.',
        });

      const [tier] = await tx<
        { seat_cap: number }[]
      >`SELECT seat_cap FROM core.tier WHERE id = 'trial'`;
      const seatCap = tier!.seat_cap;
      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO core.tenant (owner_account_id, name) VALUES (${owner!.id}, ${tenantName}) RETURNING id`;
      const [licence] = await tx<{ id: string }[]>`
        INSERT INTO core.licence (tenant_id, tier_id, kind, key_hmac, key_last4, key_cipher, seat_cap, max_devices,
                                  starts_at, ends_at, grace_days)
        VALUES (${tenant!.id}, 'trial', 'trial', ${licenceKeyHmac(parsed.body, this.config.licenceKeyPepper)},
                ${licenceKeyLast4(parsed.body)}, ${seal(parsed.formatted, this.config.controlPlaneEncKey)}, ${seatCap},
                ${seatCap * this.config.devicesPerSeat}, ${now}, ${endsAt}, ${this.config.trialGraceDays})
        RETURNING id`;
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licence!.id}, 'issued', ${actor}, ${tx.json({ tier: 'trial', endsAt: endsAt.toISOString() })})`;
      // The email worker decrypts the key at send time; the plaintext key is never stored in the outbox.
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        VALUES (${email}, 'licence_key', ${tx.json({ licenceId: licence!.id, tenantName, endsAt: endsAt.toISOString() })})`;
      // Link for the tenant admin to set their password (docs/03-architecture.md §6). 7 days, single use.
      const setupToken = randomBytes(32).toString('base64url');
      const setupUrl = new URL('/account/set-password', this.config.websiteUrl);
      setupUrl.searchParams.set('token', setupToken);
      await tx`INSERT INTO core.owner_password_token (owner_account_id, purpose, token_hmac, expires_at)
        SELECT ${owner!.id}, 'setup', ${tokenHmac(setupToken, this.config.licenceKeyPepper)}, ${addDays(now, 7)}
        WHERE NOT EXISTS (SELECT 1 FROM core.owner_account WHERE id = ${owner!.id} AND password_hash IS NOT NULL)`;
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        SELECT ${email}, 'admin_password_setup', ${tx.json({ link: seal(setupUrl.toString(), this.config.controlPlaneEncKey) })}
        WHERE NOT EXISTS (SELECT 1 FROM core.owner_account WHERE id = ${owner!.id} AND password_hash IS NOT NULL)`;
      await this.audit(
        tx,
        'tenant.create_trial',
        `tenant:${tenant!.id}`,
        { email, tenantName },
        actor,
      );
      return { tenantId: tenant!.id, licenceId: licence!.id, licenceKey: parsed.formatted, endsAt };
    });
  }

  /** Called by the desktop/browser app the first time a key is entered on a device. */
  async activate(
    rawKey: string,
    deviceId: string,
    platform: string,
    label: string | null,
    now = new Date(),
  ): Promise<ActivationResult> {
    const parsed = parseLicenceKey(rawKey);
    if (!parsed.ok) {
      throw new BadRequestException({
        code: 'invalid_key_format',
        message:
          parsed.reason === 'checksum'
            ? 'This licence key has a typo. Check it and try again.'
            : 'This is not a licence key.',
      });
    }
    const deviceHash = hashDevice(deviceId);
    return this.sql.begin(async (tx) => {
      const [licence] = await tx<LicenceRow[]>`
        SELECT * FROM core.licence WHERE key_hmac = ${licenceKeyHmac(parsed.body, this.config.licenceKeyPepper)} FOR UPDATE`;
      if (!licence)
        throw new NotFoundException({
          code: 'unknown_key',
          message: 'Licence key not recognised.',
        });
      this.assertUsable(licence, now);

      const [device] = await tx<{ id: string; revoked_at: Date | null }[]>`
        SELECT id, revoked_at FROM core.device_activation WHERE licence_id = ${licence.id} AND device_hash = ${deviceHash}`;
      if (device?.revoked_at) {
        throw new ForbiddenException({
          code: 'device_revoked',
          message: 'This device was removed by the licence owner.',
        });
      }
      if (device) {
        await tx`UPDATE core.device_activation SET last_seen_at = ${now} WHERE id = ${device.id}`;
      } else {
        const [active] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM core.device_activation WHERE licence_id = ${licence.id} AND revoked_at IS NULL`;
        if ((active?.count ?? 0) >= licence.max_devices) {
          throw new ConflictException({
            code: 'device_limit',
            message: `This licence is active on ${licence.max_devices} devices. Remove one in the customer portal first.`,
          });
        }
        await tx`INSERT INTO core.device_activation (licence_id, device_hash, platform, label, first_seen_at, last_seen_at)
          VALUES (${licence.id}, ${deviceHash}, ${platform}, ${label}, ${now}, ${now})`;
        await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
          VALUES (${licence.id}, 'activated', 'app', ${tx.json({ platform, label })})`;
      }
      return this.issueEntitlement(licence, deviceHash, now);
    });
  }

  /** Re-issues a token. Accepts an expired token (the app may have been offline) but re-checks everything in the DB. */
  async refresh(token: string, now = new Date()): Promise<ActivationResult> {
    const verified = verifyEntitlement(token, this.publicKey, Math.floor(now.getTime() / 1000));
    if (!verified.ok) throw new UnauthorizedException({ code: 'invalid_token' });
    const { lic, dev } = verified.payload;
    const [licence] = await this.sql<LicenceRow[]>`SELECT * FROM core.licence WHERE id = ${lic}`;
    if (!licence) throw new UnauthorizedException({ code: 'invalid_token' });
    this.assertUsable(licence, now);
    const [device] = await this.sql<{ id: string; revoked_at: Date | null }[]>`
      SELECT id, revoked_at FROM core.device_activation WHERE licence_id = ${lic} AND device_hash = ${dev}`;
    if (!device || device.revoked_at) throw new ForbiddenException({ code: 'device_revoked' });
    await this.sql`UPDATE core.device_activation SET last_seen_at = ${now} WHERE id = ${device.id}`;
    return this.issueEntitlement(licence, dev, now);
  }

  /** In-app notices for the tenant behind a valid (even expired) entitlement token. */
  /** Tenant and licence behind a device's entitlement token. Expired tokens are accepted; callers re-check state. */
  deviceTenant(
    token: string,
    now = new Date(),
  ): { tenantId: string; licenceId: string; deviceHash: string } {
    const verified = verifyEntitlement(token, this.publicKey, Math.floor(now.getTime() / 1000));
    if (!verified.ok) throw new UnauthorizedException({ code: 'invalid_entitlement' });
    return {
      tenantId: verified.payload.ten,
      licenceId: verified.payload.lic,
      deviceHash: verified.payload.dev,
    };
  }

  /** The tenant's current licence with its tier rules and state (latest licence wins). */
  async tenantLicence(tenantId: string, now = new Date()): Promise<TenantLicence> {
    const [row] = await this.sql<
      (LicenceRow & { role_caps: Partial<Record<Role, number>> | null })[]
    >`
      SELECT l.*, t.role_caps FROM core.licence l JOIN core.tier t ON t.id = l.tier_id
      WHERE l.tenant_id = ${tenantId} ORDER BY l.created_at DESC LIMIT 1`;
    if (!row) throw new NotFoundException({ code: 'licence_not_found' });
    return {
      licenceId: row.id,
      tierId: row.tier_id,
      seatCap: row.seat_cap,
      roleCaps: row.role_caps,
      portalCap: row.portal_cap,
      state: licenceState(
        { status: row.status, endsAt: row.ends_at, graceDays: row.grace_days },
        now,
      ),
    };
  }

  async noticesFor(token: string, now = new Date()) {
    const verified = verifyEntitlement(token, this.publicKey, Math.floor(now.getTime() / 1000));
    if (!verified.ok) throw new UnauthorizedException({ code: 'invalid_token' });
    return this.sql`
      SELECT id, kind, title, body, created_at FROM core.owner_notice
      WHERE tenant_id = ${verified.payload.ten} OR tenant_id IS NULL
      ORDER BY created_at DESC LIMIT 50`;
  }

  async changeTrialEnd(
    licenceId: string,
    newEndsAt: Date,
    reason: string,
    actor: string,
    now = new Date(),
  ) {
    return this.sql.begin(async (tx) => {
      const licence = await this.lockLicence(tx, licenceId);
      if (licence.kind !== 'trial') throw new BadRequestException({ code: 'not_a_trial' });
      const check = validateTrialChange(
        { startsAt: licence.starts_at, endsAt: licence.ends_at },
        newEndsAt,
        now,
        this.config.minShortenNoticeDays,
      );
      if (!check.ok) {
        throw new BadRequestException({
          code: check.reason,
          ...(check.earliestAllowed
            ? { earliestAllowed: check.earliestAllowed.toISOString() }
            : {}),
        });
      }
      await tx`UPDATE core.licence SET ends_at = ${newEndsAt}, row_version = row_version + 1 WHERE id = ${licenceId}`;
      await tx`INSERT INTO core.trial_change (licence_id, old_ends_at, new_ends_at, reason)
        VALUES (${licenceId}, ${licence.ends_at}, ${newEndsAt}, ${reason})`;
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licenceId}, ${check.kind}, ${actor},
                ${tx.json({ from: licence.ends_at.toISOString(), to: newEndsAt.toISOString(), reason })})`;
      const date = newEndsAt.toISOString().slice(0, 10);
      const title =
        check.kind === 'extended'
          ? 'Your trial has been extended'
          : 'Your trial end date has changed';
      const body = `Your trial now ends on ${date}.${reason ? ` ${reason}` : ''}`;
      await tx`INSERT INTO core.owner_notice (tenant_id, kind, title, body)
        VALUES (${licence.tenant_id}, ${check.kind === 'extended' ? 'trial_extended' : 'trial_shortened'}, ${title}, ${body})`;
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        SELECT o.email, 'trial_changed', ${tx.json({ licenceId, kind: check.kind, endsAt: newEndsAt.toISOString(), reason })}
        FROM core.tenant t JOIN core.owner_account o ON o.id = t.owner_account_id WHERE t.id = ${licence.tenant_id}`;
      await this.audit(
        tx,
        `licence.trial_${check.kind}`,
        `licence:${licenceId}`,
        { newEndsAt, reason },
        actor,
      );
      return { licenceId, kind: check.kind, endsAt: newEndsAt };
    });
  }

  /** Raises or lowers a tenant's fair-use cap on portal users per kind (docs/wave6-plan.md step 5). */
  async changePortalCap(licenceId: string, cap: number, reason: string, actor: string) {
    return this.sql.begin(async (tx) => {
      const licence = await this.lockLicence(tx, licenceId);
      const from = licence.portal_cap;
      if (from === cap) return { licenceId, portalCap: cap };
      await tx`UPDATE core.licence SET portal_cap = ${cap}, row_version = row_version + 1 WHERE id = ${licenceId}`;
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licenceId}, 'portal_cap_changed', ${actor}, ${tx.json({ from: from, to: cap, reason })})`;
      await this.audit(
        tx,
        'licence.portal_cap_changed',
        `licence:${licenceId}`,
        { tenantId: licence.tenant_id, from: from, to: cap, reason },
        actor,
      );
      return { licenceId, portalCap: cap };
    });
  }

  async revokeLicence(licenceId: string, reason: string, actor: string) {
    return this.sql.begin(async (tx) => {
      const licence = await this.lockLicence(tx, licenceId);
      if (licence.status === 'revoked') return { licenceId, status: 'revoked' as const };
      await tx`UPDATE core.licence SET status = 'revoked', row_version = row_version + 1 WHERE id = ${licenceId}`;
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licenceId}, 'revoked', ${actor}, ${tx.json({ reason })})`;
      await tx`INSERT INTO core.owner_notice (tenant_id, kind, title, body)
        VALUES (${licence.tenant_id}, 'licence_revoked', 'Your licence has been revoked', ${reason})`;
      await this.audit(tx, 'licence.revoke', `licence:${licenceId}`, { reason }, actor);
      return { licenceId, status: 'revoked' as const };
    });
  }

  async revokeDevice(licenceId: string, deviceActivationId: string, actor: string) {
    return this.sql.begin(async (tx) => {
      const [device] = await tx<{ id: string }[]>`
        UPDATE core.device_activation SET revoked_at = now()
        WHERE id = ${deviceActivationId} AND licence_id = ${licenceId} AND revoked_at IS NULL RETURNING id`;
      if (!device) throw new NotFoundException({ code: 'device_not_found' });
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licenceId}, 'device_revoked', ${actor}, ${tx.json({ deviceActivationId })})`;
      await this.audit(
        tx,
        'licence.device_revoke',
        `licence:${licenceId}`,
        { deviceActivationId },
        actor,
      );
      return { deviceActivationId, revoked: true };
    });
  }

  async getLicence(licenceId: string, now = new Date()) {
    const [licence] = await this.sql<LicenceRow[]>`
      SELECT id, tenant_id, tier_id, kind, status, key_last4, seat_cap, portal_cap, max_devices, starts_at, ends_at, grace_days
      FROM core.licence WHERE id = ${licenceId}`;
    if (!licence) throw new NotFoundException({ code: 'licence_not_found' });
    const devices = await this.sql`
      SELECT id, platform, label, first_seen_at, last_seen_at, revoked_at FROM core.device_activation
      WHERE licence_id = ${licenceId} ORDER BY first_seen_at`;
    const events = await this.sql`
      SELECT kind, actor, data, created_at FROM core.licence_event WHERE licence_id = ${licenceId} ORDER BY id`;
    return {
      ...licence,
      state: licenceState(
        { status: licence.status, endsAt: licence.ends_at, graceDays: licence.grace_days },
        now,
      ),
      devices,
      events,
    };
  }

  /** For "resend my key": decrypts the stored key. Owner console / verified customer portal only. */
  async revealKey(licenceId: string, actor: string): Promise<string> {
    const [row] = await this.sql<
      { key_cipher: string }[]
    >`SELECT key_cipher FROM core.licence WHERE id = ${licenceId}`;
    if (!row) throw new NotFoundException({ code: 'licence_not_found' });
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor) VALUES (${licenceId}, 'resent', ${actor})`;
      await this.audit(tx, 'licence.reveal_key', `licence:${licenceId}`, {}, actor);
    });
    return open(row.key_cipher, this.config.controlPlaneEncKey);
  }

  /** Emails the key again to the tenant's admin address. Preferred over revealKey: the key never reaches the console. */
  async resendKey(licenceId: string, actor: string) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ email: string; name: string; ends_at: Date }[]>`
        SELECT o.email, t.name, l.ends_at FROM core.licence l
        JOIN core.tenant t ON t.id = l.tenant_id JOIN core.owner_account o ON o.id = t.owner_account_id
        WHERE l.id = ${licenceId}`;
      if (!row) throw new NotFoundException({ code: 'licence_not_found' });
      await tx`INSERT INTO core.email_outbox (to_email, template, data)
        VALUES (${row.email}, 'licence_key', ${tx.json({ licenceId, tenantName: row.name, endsAt: row.ends_at.toISOString() })})`;
      await tx`INSERT INTO core.licence_event (licence_id, kind, actor, data)
        VALUES (${licenceId}, 'resent', ${actor}, ${tx.json({ to: row.email })})`;
      await this.audit(tx, 'licence.resend_key', `licence:${licenceId}`, { to: row.email }, actor);
      return { licenceId, sentTo: row.email };
    });
  }

  async recordDownload(d: {
    email: string;
    kind: 'trial' | 'paid';
    seats: number;
    platform: string;
    appVersion: string;
  }) {
    await this
      .sql`INSERT INTO core.download_event (email, kind, seats_requested, platform, app_version)
      VALUES (${d.email}, ${d.kind}, ${d.seats}, ${d.platform}, ${d.appVersion})`;
  }

  private assertUsable(licence: LicenceRow, now: Date): void {
    const state = licenceState(
      { status: licence.status, endsAt: licence.ends_at, graceDays: licence.grace_days },
      now,
    );
    if (state === 'revoked' || state === 'suspended') {
      throw new ForbiddenException({
        code: `licence_${state}`,
        message: `This licence is ${state}.`,
      });
    }
  }

  private issueEntitlement(licence: LicenceRow, deviceHash: string, now: Date): ActivationResult {
    const state = licenceState(
      { status: licence.status, endsAt: licence.ends_at, graceDays: licence.grace_days },
      now,
    );
    const iat = Math.floor(now.getTime() / 1000);
    // Never valid past the end of grace, so a cached token cannot outlive the licence.
    const graceEnd = Math.floor((licence.ends_at.getTime() + licence.grace_days * DAY_MS) / 1000);
    const ttl = iat + this.config.entitlementTtlHours * 3600;
    const exp = featuresUnlocked(state) ? Math.min(ttl, graceEnd) : iat + 24 * 3600;
    const entitlement: Entitlement = {
      v: 1,
      lic: licence.id,
      ten: licence.tenant_id,
      tier: licence.tier_id,
      seats: licence.seat_cap,
      state,
      ends: licence.ends_at.toISOString(),
      dev: deviceHash,
      iat,
      exp,
    };
    return {
      token: signEntitlement(entitlement, this.config.entitlementPrivateKey),
      entitlement,
      featuresUnlocked: featuresUnlocked(state),
    };
  }

  private async lockLicence(tx: TransactionSql, licenceId: string): Promise<LicenceRow> {
    const [licence] = await tx<
      LicenceRow[]
    >`SELECT * FROM core.licence WHERE id = ${licenceId} FOR UPDATE`;
    if (!licence) throw new NotFoundException({ code: 'licence_not_found' });
    return licence;
  }

  private async audit(
    tx: TransactionSql,
    action: string,
    target: string,
    data: Record<string, unknown>,
    actor: string,
  ) {
    await tx`INSERT INTO core.owner_audit (action, target, data)
      VALUES (${action}, ${target}, ${tx.json(JSON.parse(JSON.stringify({ ...data, actor })))})`;
  }
}
