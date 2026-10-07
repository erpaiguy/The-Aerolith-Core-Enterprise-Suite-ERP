// Recreates the e2e control database and removes tenant databases/roles left by earlier runs.
import { rmSync } from 'node:fs';
import postgres from 'postgres';

rmSync(new URL('./.mail/', import.meta.url), { recursive: true, force: true });

const adminUrl = process.env.E2E_PG_ADMIN_URL ?? 'postgres://bench:bench@127.0.0.1:5432/postgres';
const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe('DROP DATABASE IF EXISTS aerolith_e2e WITH (FORCE)');
  for (const {
    datname,
  } of await sql`SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_t%'`) {
    await sql.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`);
  }
  for (const {
    rolname,
  } of await sql`SELECT rolname FROM pg_roles WHERE rolname ~ '^t[0-9a-f]{12}_(app|migrator)$'`) {
    await sql.unsafe(`DROP ROLE "${rolname}"`);
  }
  await sql.unsafe('CREATE DATABASE aerolith_e2e');
} finally {
  await sql.end();
}
