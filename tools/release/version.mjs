// One version for the whole product (docs/release.md). The root package.json holds it; the desktop app's
// package.json must match, because the installer and app.getVersion() read that one.
//   node tools/release/version.mjs          prints it
//   node tools/release/version.mjs 1.0.0    sets it everywhere
//   node tools/release/version.mjs --check  fails if they differ (CI)
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['package.json', 'apps/desktop/package.json'];
const read = (f) => JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
const write = (f, d) =>
  writeFileSync(new URL(`../../${f}`, import.meta.url), `${JSON.stringify(d, null, 2)}\n`);

const arg = process.argv[2];
const versions = FILES.map((f) => [f, read(f).version]);
if (!arg) {
  process.stdout.write(`${versions[0][1]}\n`);
} else if (arg === '--check') {
  const wrong = versions.filter(([, v]) => v !== versions[0][1]);
  if (wrong.length) {
    process.stderr.write(`Versions differ: ${versions.map(([f, v]) => `${f} ${v}`).join(', ')}\n`);
    process.exit(1);
  }
} else if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(arg)) {
  for (const f of FILES) write(f, { ...read(f), version: arg });
  process.stdout.write(`${arg}\n`);
} else {
  process.stderr.write('A version like 1.2.0 or 1.2.0-rc.1.\n');
  process.exit(2);
}
