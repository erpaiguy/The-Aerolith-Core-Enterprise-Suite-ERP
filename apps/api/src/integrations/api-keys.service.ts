// API keys for the public API (docs/wave6-plan.md step 6). An admin makes a key with scopes; the secret is shown once
// and kept as an HMAC. A key acts as the admin or manager who made it, so their access applies on every request, and
// a maker who is deactivated or loses that role takes their keys with them.
import { randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { hmacSecret } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { parseApiKey, type Scope } from './integration-rules.js';

export interface KeyPrincipal {
  claims: TenantClaims;
  keyId: string;
  scopes: Scope[];
}

export function mustBeAdmin(claims: TenantClaims) {
  if (claims.role !== 'admin')
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Only an admin manages integrations.',
    });
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly licensing: LicensingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(claims: TenantClaims) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT k.id, k.name, k.scopes, k.last4, k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt",
        k.revoked_at AS "revokedAt", u.display_name AS "createdBy"
      FROM platform.api_key k JOIN platform."user" u ON u.id = k.created_by
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`;
  }

  async create(claims: TenantClaims, input: { name: string; scopes: Scope[] }) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const secret = randomBytes(32).toString('base64url');
    const id = await db.begin(async (tx) => {
      const [k] = await tx<{ id: string }[]>`
        INSERT INTO platform.api_key (name, secret_hmac, last4, scopes, created_by)
        VALUES (${input.name}, ${hmacSecret(secret, this.config.sessionKey)}, ${secret.slice(-4)},
                ${input.scopes}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'api_key.create', 'api_key', k!.id, {
        name: input.name,
        scopes: input.scopes,
      });
      return k!.id;
    });
    return { id, key: `aek1.${claims.ten}.${id}.${secret}` };
  }

  async revoke(claims: TenantClaims, id: string) {
    mustBeAdmin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [k] = await tx`
        UPDATE platform.api_key SET revoked_at = now(), revoked_by = ${claims.sub}
        WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
      if (!k) throw new NotFoundException({ code: 'not_found', message: 'No such key.' });
      await audit(tx, claims.sub, 'api_key.revoke', 'api_key', id, {});
    });
    return this.list(claims);
  }

  /** The principal behind a presented key, or 401. */
  async resolve(raw: string): Promise<KeyPrincipal> {
    const parsed = parseApiKey(raw);
    const refused = () => new UnauthorizedException({ code: 'invalid_api_key' });
    if (!parsed) throw refused();
    let db;
    try {
      db = await this.tenants.forTenant(parsed.tenant);
    } catch {
      throw refused();
    }
    const [k] = await db<
      {
        secret_hmac: string;
        scopes: Scope[];
        created_by: string;
        role: TenantClaims['role'];
        status: string;
        last_used_at: Date | null;
      }[]
    >`
      SELECT k.secret_hmac, k.scopes, k.created_by, u.role, u.status, k.last_used_at
      FROM platform.api_key k JOIN platform."user" u ON u.id = k.created_by
      WHERE k.id = ${parsed.id} AND k.revoked_at IS NULL`;
    if (!k || k.secret_hmac !== hmacSecret(parsed.secret, this.config.sessionKey)) throw refused();
    if (k.status !== 'active' || k.role === 'worker') throw refused();
    const lic = await this.licensing.tenantLicence(parsed.tenant);
    if (lic.state === 'revoked' || lic.state === 'suspended')
      throw new ForbiddenException({ code: `licence_${lic.state}` });
    if (!k.last_used_at || Date.now() - k.last_used_at.getTime() > 60_000)
      await db`UPDATE platform.api_key SET last_used_at = now() WHERE id = ${parsed.id}`;
    const now = Math.floor(Date.now() / 1000);
    return {
      keyId: parsed.id,
      scopes: k.scopes,
      claims: {
        v: 1,
        kind: 'tenant',
        ten: parsed.tenant,
        sub: k.created_by,
        role: k.role,
        sid: `api-key:${parsed.id}`,
        mcp: false,
        lic: lic.state,
        iat: now,
        exp: now + 60,
      },
    };
  }
}
