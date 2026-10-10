// Fails when two tracked paths differ only in letter case, or two source modules do once their extension is dropped
// (imports name modules without it). Linux treats them as different; Windows and macOS do not, so the desktop build
// on Windows breaks, as it did for documents/Thumbnail.tsx next to documents/thumbnail.ts.
import { execFileSync } from 'node:child_process';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const seen = new Map();
const clashes = new Set();
const note = (name, k) => {
  const had = seen.get(k);
  if (had === undefined) seen.set(k, name);
  else if (had !== name) clashes.add(`${had}  <->  ${name}`);
};
for (const f of files) {
  const parts = f.split('/');
  // Files and the folders they are in.
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    note(p, `path:${p.toLowerCase()}`);
  }
  if (SOURCE.test(f)) note(f, `module:${f.replace(SOURCE, '').toLowerCase()}`);
}
// Two sources of the same module in the same case (a.ts and a.tsx) are a different problem, not this one.
const real = [...clashes].filter((c) => {
  const [a, b] = c.split('  <->  ');
  return a.replace(SOURCE, '') !== b.replace(SOURCE, '');
});
if (real.length) {
  for (const c of real) console.error(`Differ only in letter case: ${c}`);
  process.exit(1);
}
console.log(`Case check passed: ${files.length} files.`);
