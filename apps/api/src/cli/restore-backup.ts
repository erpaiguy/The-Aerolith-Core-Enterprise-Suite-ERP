// Restores a tenant backup file (docs/wave8-plan.md step 8g.2) into a database, replacing everything in it.
// Usage: pnpm --filter @aerolith/api restore:backup <file.aeb.gz> <postgres URL of the target database> --replace
// The URL must be a superuser's (triggers are switched off while loading). The target is migrated first; a backup
// from a newer version of the app is refused. Nothing changes unless every table loads.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import postgres from 'postgres';
import { migrate, TENANT_MIGRATIONS } from '../db/migrate.js';
import { OWNER_GROUP } from '../provisioning/bootstrap.js';
import { restoreDatabase } from '../backup/dump.js';

async function main(): Promise<void> {
  const [file, url, flag] = process.argv.slice(2);
  if (!file || !url || flag !== '--replace') {
    process.stderr.write(
      'Usage: restore-backup <file.aeb.gz> <superuser postgres URL of the target> --replace\n' +
        'Everything in the target database is replaced by the backup.\n',
    );
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: false });
  try {
    await migrate(sql, TENANT_MIGRATIONS, { asRole: OWNER_GROUP });
    const r = await restoreDatabase(sql, createReadStream(file).pipe(createGunzip()));
    process.stdout.write(
      `Restored ${r.tables} tables, ${r.rows} rows, from the backup of ${r.header.createdAt}.\n`,
    );
    if (r.problems.length) {
      process.stderr.write(`Problems:\n${r.problems.join('\n')}\n`);
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
