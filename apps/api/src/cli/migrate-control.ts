// Usage: CONTROL_DATABASE_URL=postgres://... pnpm --filter @aerolith/api migrate:control
import { loadConfig } from '../config/config.js';
import { connectControlDb } from '../db/db.module.js';
import { migrate } from '../db/migrate.js';

async function main(): Promise<void> {
  const sql = connectControlDb(loadConfig().controlDatabaseUrl);
  try {
    const { applied, skipped } = await migrate(sql);
    process.stdout.write(
      `applied: ${applied.join(', ') || 'none'}; already applied: ${skipped.length}\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
