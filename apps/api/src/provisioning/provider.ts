// A provider creates and locates a tenant's database. Everything after that (roles, migrations, connections) is
// provider-independent.

export type ProviderKind = 'supabase' | 'local_postgres';
export type ProviderStatus = 'creating' | 'ready' | 'paused' | 'failed';

export interface TenantDbRecord {
  id: string;
  tenant_id: string;
  provider: ProviderKind | 'byo_postgres';
  status: string;
  role_prefix: string;
  external_ref: string | null;
  organisation_ref: string | null;
  region: string | null;
  admin_secret: string | null;
  app_url_secret: string | null;
  migrator_url_secret: string | null;
  oauth_secret: string | null;
  schema_version: string | null;
  attempts: number;
  last_error: string | null;
}

export interface CreatedDatabase {
  externalRef: string;
  region: string | null;
  /** Database admin password chosen at creation (Supabase); stored sealed for bootstrap re-runs. */
  adminPassword: string | null;
}

export interface DatabaseProvider {
  readonly kind: ProviderKind;
  /** True when several tenants share one Postgres server, so databases must be closed to PUBLIC. */
  readonly sharedServer: boolean;
  create(t: TenantDbRecord): Promise<CreatedDatabase>;
  status(t: TenantDbRecord): Promise<ProviderStatus>;
  /** Connection URL with admin rights, used once to bootstrap roles. */
  adminUrl(t: TenantDbRecord, adminPassword: string | null): Promise<string>;
  /** Connection URL for a tenant login role. `migrate` needs session semantics; `app` may use a transaction pooler. */
  roleUrl(
    t: TenantDbRecord,
    role: string,
    password: string,
    purpose: 'migrate' | 'app',
  ): Promise<string>;
  /** Database name to grant on during bootstrap. */
  databaseName(t: TenantDbRecord): string;
}
