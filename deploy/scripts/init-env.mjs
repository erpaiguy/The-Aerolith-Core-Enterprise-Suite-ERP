// Creates deploy/.env from deploy/.env.example with fresh secrets, like init-env.sh, but needing only Node (which the
// Docker image already has), so it works the same on Windows, macOS and Linux:
//   docker run --rm -v "${PWD}/deploy:/deploy" node:22-bookworm-slim node /deploy/scripts/init-env.mjs
// Refuses to overwrite an existing deploy/.env.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deploy = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(deploy, '.env');
if (existsSync(target)) {
  console.error(
    'deploy/.env already exists; not overwriting. Delete it first if you really want new secrets.',
  );
  process.exit(1);
}
const rand = () => randomBytes(32).toString('base64url');
const pem = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
  .trim()
  .replace(/\n/g, '\\n');
const values = {
  POSTGRES_PASSWORD: rand(),
  SESSION_SIGNING_KEY: rand(),
  LICENCE_KEY_PEPPER: rand(),
  CONTROL_PLANE_ENC_KEY: randomBytes(32).toString('base64'),
  ENTITLEMENT_PRIVATE_KEY_PEM: `"${pem}"`,
};
let env = readFileSync(join(deploy, '.env.example'), 'utf8');
for (const [k, v] of Object.entries(values))
  env = env.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
writeFileSync(target, env, { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows file systems ignore it.
}
console.log('Created deploy/.env with new secrets.');
