// Licence gate (docs/licensing-policy.md). Fails the build when a dependency's licence is banned or unknown.
// Production dependencies: every licence must be in `allowed`.
// Dev-only dependencies: `allowed` or `reviewOnlyForDev`; never `banned`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('./license-policy.json', import.meta.url), 'utf8'));
const allowed = new Set(policy.allowed);
const review = new Set(policy.reviewOnlyForDev);
const banned = new Set(policy.banned);

function listLicenses(prodOnly) {
  const args = ['licenses', 'list', '--json', '--recursive'];
  if (prodOnly) args.push('--prod');
  const out = execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const byLicense = JSON.parse(out || '{}');
  const packages = [];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const pkg of pkgs) packages.push({ name: pkg.name, versions: pkg.versions, license });
  }
  return packages;
}

// Evaluates an SPDX-like expression: "A OR B" passes if any branch passes, "A AND B" only if all do.
function satisfies(expression, accept) {
  const expr = expression.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/i.test(expr)) return expr.split(/\s+OR\s+/i).some((part) => satisfies(part, accept));
  if (/\sAND\s/i.test(expr))
    return expr.split(/\s+AND\s+/i).every((part) => satisfies(part, accept));
  return accept(expr.replace(/\+$/, '').trim());
}

const isOwnWorkspace = (name) => name.startsWith('@aerolith/') || name === 'aerolith-core';
const prod = listLicenses(true);
const prodNames = new Set(prod.map((p) => `${p.name}@${p.versions.join(',')}`));
const all = listLicenses(false);

const failures = [];
for (const pkg of all) {
  if (isOwnWorkspace(pkg.name) || policy.exceptions[pkg.name]) continue;
  const isProd = prodNames.has(`${pkg.name}@${pkg.versions.join(',')}`);
  const ok = isProd
    ? satisfies(pkg.license, (id) => allowed.has(id))
    : satisfies(pkg.license, (id) => (allowed.has(id) || review.has(id)) && !banned.has(id));
  if (!ok)
    failures.push(
      `${isProd ? 'prod' : 'dev '}  ${pkg.name}@${pkg.versions.join(',')}  ${pkg.license}`,
    );
}

const counted = all.filter((p) => !isOwnWorkspace(p.name)).length;
if (failures.length > 0) {
  console.error(`Licence check FAILED (${failures.length} of ${counted} packages):`);
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    'See docs/licensing-policy.md. Replace the dependency or record a justified exception.',
  );
  process.exit(1);
}
console.log(`Licence check passed: ${counted} third-party packages (${prod.length} production).`);
