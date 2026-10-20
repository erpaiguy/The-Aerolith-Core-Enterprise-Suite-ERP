// Makes the release signing key pair (docs/release.md). Run once, by the publisher, on a trusted machine:
//   node tools/release/keygen.mjs
// Keep the private key secret (a GitHub Actions secret or a password manager); never commit it. Give the public key to
// every installation as RELEASE_PUBLIC_KEY (server) and AEROLITH_RELEASE_PUBLIC_KEY (desktop build).
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.stdout.write(
  `RELEASE_PUBLIC_KEY=${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}\n` +
    `RELEASE_SIGNING_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}\n`,
);
