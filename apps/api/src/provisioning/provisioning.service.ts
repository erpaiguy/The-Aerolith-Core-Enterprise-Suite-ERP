// Provisioning state machine (docs/infra-existing-stack.md §5):
//   creating -> bootstrapping -> migrating -> ready
// Each step is idempotent and retried with backoff, so a crash or a slow Supabase project just means the next
// attempt picks up where the last one stopped.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import postgres, { type Sql } from 'postgres';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { open, seal } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { migrate, migrationFiles, TENANT_MIGRATIONS } from '../db/migrate.js';
import {
  OWNER_GROUP,
  bootstrapTenantDatabase,
  newTenantRoles,
  rolePrefixFor,
} from './bootstrap.js';
import { LocalPostgresProvider } from './local-postgres.provider.js';
import type { DatabaseProvider, ProviderKind, TenantDbRecord } from './provider.js';
import { SupabaseClient } from './supabase.client.js';
import { SupabaseProvider } from './supabase.provider.js';

const MAX_ATTEMPTS = 10;
const POLL_MS = 5_000;

/** Exponential backoff: 5 s, 10 s, 20 s ... capped at 10 minutes. */
export const backoffMs = (attempt: number): number =>
  Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 600_000);

const IN_PROGRESS = ['creating', 'bootstrapping', 'migrating'] as const;

export interface TenantDbStatus {
  tenantId: string;
  provider: string;
  status: string;
  region: string | null;
  schemaVersion: string | null;
  attempts: number;
  lastError: string | null;
}

@Injectable()
export class ProvisioningService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Provisioning');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly supabaseClient: SupabaseClient | null;

  constructor(
    @Inject(CONTROL_DB) private readonly sql: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.supabaseClient = config.supabase ? new SupabaseClient(config.supabase) : null;
  }

  onApplicationBootstrap(): void {
    if (this.config.provisioningWorker) this.timer = setInterval(() => void this.runDue(), POLL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  provider(kind: TenantDbRecord['provider']): DatabaseProvider {
    if (kind === 'local_postgres') {
      if (!this.config.localPgAdminUrl)
        throw new BadRequestException({ code: 'local_provider_disabled' });
      return new LocalPostgresProvider(this.config.localPgAdminUrl);
    }
    if (kind === 'supabase') {
      if (!this.supabaseClient) throw new BadRequestException({ code: 'supabase_not_configured' });
      return new SupabaseProvider(
        this.supabaseClient,
        this.config.controlPlaneEncKey,
        this.config.tenantDbRegion,
        async (id, sealed) => {
          await this
            .sql`UPDATE core.tenant_db SET oauth_secret = ${sealed}, updated_at = now() WHERE id = ${id}`;
        },
      );
    }
    throw new BadRequestException({ code: 'provider_not_supported', provider: kind });
  }

  /** Registers the tenant's database record. Supabase records wait for consent; others start creating at once. */
  async register(tenantId: string, provider: ProviderKind): Promise<TenantDbStatus> {
    const [tenant] = await this.sql`SELECT 1 FROM core.tenant WHERE id = ${tenantId}`;
    if (!tenant) throw new NotFoundException({ code: 'tenant_not_found' });
    if (provider === 'local_postgres') this.provider(provider); // fail fast if disabled
    const status = provider === 'supabase' ? 'awaiting_consent' : 'creating';
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO core.tenant_db (tenant_id, provider, status, role_prefix, next_attempt_at)
      VALUES (${tenantId}, ${provider}, ${status}, ${rolePrefixFor(tenantId)}, now())
      ON CONFLICT (tenant_id) DO NOTHING RETURNING id`;
    if (!row) throw new ConflictException({ code: 'already_registered' });
    return this.status(tenantId);
  }

  async status(tenantId: string): Promise<TenantDbStatus> {
    const [t] = await this.sql<
      TenantDbRecord[]
    >`SELECT * FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
    if (!t) throw new NotFoundException({ code: 'tenant_db_not_found' });
    return {
      tenantId,
      provider: t.provider,
      status: t.status,
      region: t.region,
      schemaVersion: t.schema_version,
      attempts: t.attempts,
      lastError: t.last_error,
    };
  }

  /** Advances every due record by one step. Safe to call concurrently (row locks + SKIP LOCKED). */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.sql<{ id: string }[]>`
        SELECT id FROM core.tenant_db
        WHERE status IN ${this.sql(IN_PROGRESS)} AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY next_attempt_at NULLS FIRST LIMIT 20`;
      for (const { id } of due) await this.advance(id);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  /** Test/ops helper: keep stepping one record until it stops changing state or reaches a terminal state. */
  async runUntilSettled(tenantId: string, maxSteps = 10): Promise<TenantDbStatus> {
    for (let i = 0; i < maxSteps; i++) {
      const [t] = await this.sql<
        { id: string; status: string }[]
      >`SELECT id, status FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
      if (!t || !(IN_PROGRESS as readonly string[]).includes(t.status)) break;
      const before = t.status;
      await this.advance(t.id);
      const after = await this.status(tenantId);
      if (after.status === before) break; // waiting on something external
    }
    return this.status(tenantId);
  }

  async advance(id: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [t] = await tx<
        TenantDbRecord[]
      >`SELECT * FROM core.tenant_db WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
      if (!t || !(IN_PROGRESS as readonly string[]).includes(t.status)) return;
      try {
        const next = await this.step(t);
        await tx`UPDATE core.tenant_db SET ${tx(next as Record<string, unknown>)}, attempts = 0, last_error = NULL,
          last_checked_at = now(), updated_at = now() WHERE id = ${id}`;
      } catch (err) {
        const attempts = t.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`tenant ${t.tenant_id} ${t.status} attempt ${attempts} failed: ${message}`);
        await tx`UPDATE core.tenant_db SET attempts = ${attempts}, last_error = ${message.slice(0, 1000)},
          status = ${attempts >= MAX_ATTEMPTS ? 'failed' : t.status},
          next_attempt_at = ${new Date(Date.now() + backoffMs(attempts))}, last_checked_at = now(), updated_at = now()
          WHERE id = ${id}`;
      }
    });
  }

  /** Performs one step and returns the columns to update. Never throws away progress: each step can be re-run. */
  private async step(
    t: TenantDbRecord,
  ): Promise<Partial<TenantDbRecord> & { next_attempt_at: Date }> {
    const provider = this.provider(t.provider);
    const now = new Date();
    const enc = this.config.controlPlaneEncKey;

    if (t.status === 'creating') {
      let created: Partial<TenantDbRecord> = {};
      if (!t.external_ref) {
        const db = await provider.create(t);
        created = {
          external_ref: db.externalRef,
          region: db.region,
          admin_secret: db.adminPassword ? seal(db.adminPassword, enc) : null,
        };
        Object.assign(t, created);
      }
      const status = await provider.status(t);
      if (status === 'failed') throw new Error('provider reports the database failed to start');
      if (status !== 'ready')
        return { ...created, next_attempt_at: new Date(now.getTime() + 15_000) };
      return { ...created, status: 'bootstrapping', next_attempt_at: now };
    }

    if (t.status === 'bootstrapping') {
      const roles = newTenantRoles(t.role_prefix);
      const adminPassword = t.admin_secret ? open(t.admin_secret, enc) : null;
      const admin = postgres(await provider.adminUrl(t, adminPassword), {
        max: 1,
        onnotice: () => {},
        connect_timeout: 15,
      });
      try {
        await bootstrapTenantDatabase(admin, provider.databaseName(t), roles, {
          isolateDatabase: provider.sharedServer,
        });
      } finally {
        await admin.end();
      }
      return {
        status: 'migrating',
        migrator_url_secret: seal(
          await provider.roleUrl(t, roles.migrator, roles.migratorPassword, 'migrate'),
          enc,
        ),
        app_url_secret: seal(await provider.roleUrl(t, roles.app, roles.appPassword, 'app'), enc),
        next_attempt_at: now,
      };
    }

    // migrating
    if (!t.migrator_url_secret) throw new Error('missing migrator credentials');
    const migrator = postgres(open(t.migrator_url_secret, enc), {
      max: 1,
      onnotice: () => {},
      connect_timeout: 15,
      prepare: false,
    });
    try {
      await migrate(migrator, TENANT_MIGRATIONS, { asRole: OWNER_GROUP });
    } finally {
      await migrator.end();
    }
    return {
      status: 'ready',
      schema_version: migrationFiles(TENANT_MIGRATIONS).at(-1) ?? null,
      next_attempt_at: now,
    };
  }
}
