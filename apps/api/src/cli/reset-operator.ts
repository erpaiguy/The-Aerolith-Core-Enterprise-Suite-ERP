// Break-glass reset for an owner-console account (lost phone and recovery codes, or a forgotten password). Usage:
//   pnpm --filter @aerolith/api operator:reset -- --email you@yourdomain.in
//   docker compose -f deploy/docker-compose.yml exec api node dist/cli/reset-operator.js --email you@yourdomain.in
// Prints a new one-time password. The authenticator and recovery codes are cleared and every session is signed out,
// so the next sign-in sets up the authenticator again.
import { parseArgs } from 'node:util';
import { MfaService } from '../auth/mfa.service.js';
import { OperatorAuthService } from '../auth/operator-auth.service.js';
import { loadConfig } from '../config/config.js';
import { connectControlDb } from '../db/db.module.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' } } });
  if (!values.email) throw new Error('usage: operator:reset -- --email <email>');
  const config = loadConfig();
  const sql = connectControlDb(config.controlDatabaseUrl);
  try {
    const service = new OperatorAuthService(sql, config, new MfaService(sql, config));
    const { temporaryPassword } = await service.resetOperator(values.email);
    process.stdout.write(
      `Operator reset: ${values.email}\n` +
        `One-time password: ${temporaryPassword}\n` +
        'All sessions were signed out. Sign in, set up your authenticator again, then change this password.\n',
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { response?: { code?: string } }).response?.code;
  console.error(
    code === 'operator_not_found'
      ? 'No operator with that email.'
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exit(1);
});
