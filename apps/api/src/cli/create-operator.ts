// Creates an owner-console account. Usage:
//   pnpm --filter @aerolith/api operator:create -- --email you@yourdomain.in --name "Your Name" [--role owner]
// Prints a one-time password. First sign-in requires setting up an authenticator app and changing the password.
import { parseArgs } from 'node:util';
import { OperatorAuthService, type OperatorRole } from '../auth/operator-auth.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { loadConfig } from '../config/config.js';
import { connectControlDb } from '../db/db.module.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'owner' },
    },
  });
  if (
    !values.email ||
    !values.name ||
    !['owner', 'support', 'read_only'].includes(values.role ?? '')
  ) {
    throw new Error(
      'usage: operator:create -- --email <email> --name "<name>" [--role owner|support|read_only]',
    );
  }
  const config = loadConfig();
  const sql = connectControlDb(config.controlDatabaseUrl);
  try {
    const service = new OperatorAuthService(sql, config, new MfaService(sql, config));
    const { temporaryPassword } = await service.createOperator(
      values.email,
      values.name,
      values.role as OperatorRole,
    );
    process.stdout.write(
      `Operator created: ${values.email} (${values.role})\n` +
        `One-time password: ${temporaryPassword}\n` +
        'Sign in at /api/owner/auth/login, set up your authenticator app, then change this password.\n',
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { response?: { code?: string } }).response?.code;
  console.error(
    code === 'operator_exists'
      ? 'An operator with that email already exists.'
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exit(1);
});
