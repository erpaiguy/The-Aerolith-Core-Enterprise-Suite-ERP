// Prints a fresh set of production secrets in .env format. Store the output in the server's secret store, never in git.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = (k: string) => k.trim().replace(/\n/g, '\\n');
const lines = [
  `SESSION_SIGNING_KEY=${randomBytes(32).toString('base64url')}`,
  `LICENCE_KEY_PEPPER=${randomBytes(32).toString('base64url')}`,
  `CONTROL_PLANE_ENC_KEY=${randomBytes(32).toString('base64')}`,
  `ENTITLEMENT_PRIVATE_KEY_PEM="${pem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())}"`,
  `# Public key for the desktop/web app to verify entitlement tokens (safe to ship):`,
  `# ENTITLEMENT_PUBLIC_KEY_PEM="${pem(publicKey.export({ type: 'spki', format: 'pem' }).toString())}"`,
];
process.stdout.write(lines.join('\n') + '\n');
