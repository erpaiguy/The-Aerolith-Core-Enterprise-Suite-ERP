// Role layout inside every tenant database (docs/05-database.md §9, docs/09-security.md §3.1):
//
//   aerolith_owner  NOLOGIN group  owns every object; migrations run as this role
//   aerolith_app    NOLOGIN group  data access only (SELECT/INSERT/UPDATE/DELETE), no DDL
//   <prefix>_migrator  LOGIN, member of aerolith_owner   used only by the migration orchestrator
//   <prefix>_app       LOGIN, member of aerolith_app     used by the API at runtime
//
// Login roles are per tenant. On a shared Postgres server (local provider) the database is additionally closed to
// PUBLIC so one tenant's login roles cannot even connect to another tenant's database.
import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { quoteIdent } from '../db/migrate.js';

export const OWNER_GROUP = 'aerolith_owner';
export const APP_GROUP = 'aerolith_app';

export interface TenantRoles {
  migrator: string;
  app: string;
  migratorPassword: string;
  appPassword: string;
}

export const rolePrefixFor = (tenantId: string): string =>
  `t${tenantId.replace(/-/g, '').slice(0, 12)}`;

export function newTenantRoles(prefix: string): TenantRoles {
  quoteIdent(`${prefix}_migrator`);
  return {
    migrator: `${prefix}_migrator`,
    app: `${prefix}_app`,
    migratorPassword: randomBytes(24).toString('base64url'),
    appPassword: randomBytes(24).toString('base64url'),
  };
}

const literal = (s: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('unsafe password literal');
  return `'${s}'`;
};

/** Idempotent: safe to re-run after a partial failure (passwords are reset to the new values). */
export async function bootstrapTenantDatabase(
  admin: Sql,
  database: string,
  roles: TenantRoles,
  opts: { isolateDatabase: boolean },
): Promise<void> {
  const db = quoteIdent(database);
  const owner = quoteIdent(OWNER_GROUP);
  const app = quoteIdent(APP_GROUP);
  const migrator = quoteIdent(roles.migrator);
  const appLogin = quoteIdent(roles.app);

  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_GROUP}') THEN CREATE ROLE ${owner} NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_GROUP}') THEN CREATE ROLE ${app} NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roles.migrator}') THEN
        CREATE ROLE ${migrator} LOGIN PASSWORD ${literal(roles.migratorPassword)} IN ROLE ${owner};
      ELSE
        ALTER ROLE ${migrator} LOGIN PASSWORD ${literal(roles.migratorPassword)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roles.app}') THEN
        CREATE ROLE ${appLogin} LOGIN PASSWORD ${literal(roles.appPassword)} IN ROLE ${app};
      ELSE
        ALTER ROLE ${appLogin} LOGIN PASSWORD ${literal(roles.appPassword)};
      END IF;
    END $$;
  `);
  await admin.unsafe(`GRANT ${owner} TO ${migrator}; GRANT ${app} TO ${appLogin};`);
  if (opts.isolateDatabase) {
    await admin.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${db} TO ${migrator}, ${appLogin}`);
  }
  await admin.unsafe(`GRANT CREATE ON DATABASE ${db} TO ${owner}`);
  await admin.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await admin.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
  );
  await admin.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
  );
}
