// Plain-SQL migration runner (docs/05-database.md §10): ordered files, checksummed, each applied once in its own
// transaction. Changing an applied file is an error, never a silent re-run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';

export const CONTROL_PLANE_MIGRATIONS = join(__dirname, '..', '..', 'migrations', 'control-plane');
const LOCK_ID = 7_310_001; // arbitrary, unique to this runner

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  sql: Sql,
  dir: string = CONTROL_PLANE_MIGRATIONS,
): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE SCHEMA IF NOT EXISTS aerolith_meta`;
    await tx`CREATE TABLE IF NOT EXISTS aerolith_meta.schema_migration (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Map(
      (
        await tx<
          { name: string; checksum: string }[]
        >`SELECT name, checksum FROM aerolith_meta.schema_migration`
      ).map((r) => [r.name, r.checksum]),
    );
    for (const file of files) {
      const body = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum)
          throw new Error(`migration ${file} was changed after it was applied`);
        result.skipped.push(file);
        continue;
      }
      await tx.unsafe(body);
      await tx`INSERT INTO aerolith_meta.schema_migration (name, checksum) VALUES (${file}, ${checksum})`;
      result.applied.push(file);
    }
  });
  return result;
}
