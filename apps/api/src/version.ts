// The product's version (docs/wave9-plan.md step 9b.6): APP_VERSION when the image sets it, else the root
// package.json's, so a server run from a checkout reports the same number as the web app it serves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function fromPackage(): string | null {
  for (const up of [
    ['..', '..', '..'],
    ['..', '..'],
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, ...up, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'aerolith-core' && pkg.version) return pkg.version;
    } catch {
      // not there in this layout
    }
  }
  return null;
}

export const API_VERSION = process.env.APP_VERSION ?? fromPackage() ?? '0.0.0-dev';
