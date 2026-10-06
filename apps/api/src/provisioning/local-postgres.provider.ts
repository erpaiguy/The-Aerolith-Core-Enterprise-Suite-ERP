// Stand-in provider: one database per tenant on a Postgres server we control (developer machines, the owner-PC
// stage 0, CI, and later self-hosted/own-Postgres tenants). Needs a superuser URL in LOCAL_PG_ADMIN_URL.
import postgres from 'postgres';
import { quoteIdent } from '../db/migrate.js';
import type {
  CreatedDatabase,
  DatabaseProvider,
  ProviderStatus,
  TenantDbRecord,
} from './provider.js';

export class LocalPostgresProvider implements DatabaseProvider {
  readonly kind = 'local_postgres' as const;
  readonly sharedServer = true;

  constructor(private readonly adminServerUrl: string) {}

  databaseName(t: TenantDbRecord): string {
    return t.external_ref ?? `tenant_${t.role_prefix}`;
  }

  async create(t: TenantDbRecord): Promise<CreatedDatabase> {
    const name = this.databaseName(t);
    await this.withServer(async (sql) => {
      const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
      if (!exists) await sql.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
    });
    return { externalRef: name, region: null, adminPassword: null };
  }

  async status(t: TenantDbRecord): Promise<ProviderStatus> {
    return this.withServer(async (sql) => {
      const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${this.databaseName(t)}`;
      return exists ? 'ready' : 'creating';
    });
  }

  async adminUrl(t: TenantDbRecord): Promise<string> {
    const url = new URL(this.adminServerUrl);
    url.pathname = `/${this.databaseName(t)}`;
    return url.toString();
  }

  async roleUrl(t: TenantDbRecord, role: string, password: string): Promise<string> {
    const url = new URL(this.adminServerUrl);
    url.username = role;
    url.password = password;
    url.pathname = `/${this.databaseName(t)}`;
    return url.toString();
  }

  private async withServer<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(this.adminServerUrl, { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }
}
