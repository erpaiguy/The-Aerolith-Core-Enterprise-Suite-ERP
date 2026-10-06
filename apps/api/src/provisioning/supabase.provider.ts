// Tenant projects in the tenant's own Supabase organisation (owner decision, docs/05-database.md §12).
// Connections go through Supabase's pooler: session mode for bootstrap and migrations, transaction mode for the app.
// [Likely] Supabase direct database hosts are IPv6-only on free projects, which the pooler avoids.
import { randomBytes } from 'node:crypto';
import { open, seal } from '../crypto/secretbox.js';
import type {
  CreatedDatabase,
  DatabaseProvider,
  ProviderStatus,
  TenantDbRecord,
} from './provider.js';
import {
  mapProjectStatus,
  type OAuthTokens,
  type PoolerConfig,
  type SupabaseClient,
} from './supabase.client.js';

const REFRESH_MARGIN_MS = 60_000;

export class SupabaseProvider implements DatabaseProvider {
  readonly kind = 'supabase' as const;
  readonly sharedServer = false;

  constructor(
    private readonly client: SupabaseClient,
    private readonly encKey: Buffer,
    private readonly region: string,
    /** Persists refreshed OAuth tokens (sealed) for the tenant. */
    private readonly saveTokens: (tenantDbId: string, sealed: string) => Promise<void>,
  ) {}

  databaseName(): string {
    return 'postgres';
  }

  async create(t: TenantDbRecord): Promise<CreatedDatabase> {
    if (!t.organisation_ref) throw new Error('no Supabase organisation chosen');
    const adminPassword = randomBytes(24).toString('base64url');
    const project = await this.client.createProject(await this.accessToken(t), {
      name: `aerolith-${t.role_prefix}`,
      organisationId: t.organisation_ref,
      region: this.region,
      dbPassword: adminPassword,
    });
    return { externalRef: project.id, region: project.region ?? this.region, adminPassword };
  }

  async status(t: TenantDbRecord): Promise<ProviderStatus> {
    if (!t.external_ref) return 'creating';
    return mapProjectStatus(
      (await this.client.getProject(await this.accessToken(t), t.external_ref)).status,
    );
  }

  async adminUrl(t: TenantDbRecord, adminPassword: string | null): Promise<string> {
    if (!adminPassword) throw new Error('missing Supabase database password');
    return this.poolerUrl(t, 'postgres', adminPassword, 'session');
  }

  async roleUrl(
    t: TenantDbRecord,
    role: string,
    password: string,
    purpose: 'migrate' | 'app',
  ): Promise<string> {
    return this.poolerUrl(t, role, password, purpose === 'app' ? 'transaction' : 'session');
  }

  private async poolerUrl(
    t: TenantDbRecord,
    role: string,
    password: string,
    mode: 'session' | 'transaction',
  ): Promise<string> {
    if (!t.external_ref) throw new Error('project not created yet');
    const configs = await this.client.getPooler(await this.accessToken(t), t.external_ref);
    const pick: PoolerConfig | undefined = configs.find((c) => c.pool_mode === mode) ?? configs[0];
    if (!pick) throw new Error('Supabase returned no pooler configuration');
    // Supavisor identifies the project from the user name: <role>.<project-ref>
    const url = new URL(`postgres://${pick.db_host}`);
    // Supavisor serves session mode on 5432 and transaction mode on 6543 of the same host.
    url.port = String(pick.pool_mode === mode ? pick.db_port : mode === 'session' ? 5432 : 6543);
    url.username = `${role}.${t.external_ref}`;
    url.password = password;
    url.pathname = `/${pick.db_name || 'postgres'}`;
    url.searchParams.set('sslmode', 'require');
    return url.toString();
  }

  private async accessToken(t: TenantDbRecord): Promise<string> {
    if (!t.oauth_secret) throw new Error('tenant has not connected Supabase');
    let tokens = JSON.parse(open(t.oauth_secret, this.encKey)) as OAuthTokens;
    if (tokens.expiresAt - REFRESH_MARGIN_MS <= Date.now()) {
      tokens = await this.client.refresh(tokens.refreshToken);
      const sealed = seal(JSON.stringify(tokens), this.encKey);
      await this.saveTokens(t.id, sealed);
      t.oauth_secret = sealed;
    }
    return tokens.accessToken;
  }
}
