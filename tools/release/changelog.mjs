// The changelog for a release, from the commits since the last release tag (docs/release.md):
//   node tools/release/changelog.mjs 1.0.0 > release/notes.md     (and prepends the same to CHANGELOG.md with --write)
// Commit subjects are written for people ("9a.5 data grids: column choice, …"), so they are listed as they are,
// grouped by wave step; merge commits and formatting-only commits are left out.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  process.stderr.write('Usage: node tools/release/changelog.mjs <version> [--write]\n');
  process.exit(2);
}
const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let since = '';
try {
  since = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
} catch {
  // no release yet: everything
}
const subjects = git('log', '--no-merges', '--format=%s', ...(since ? [`${since}..HEAD`] : []))
  .split('\n')
  .filter(Boolean)
  .filter((s) => !/^(Format|Merge|WIP)\b/i.test(s));

const groupOf = (s) => {
  const m = /^(\d+[a-z]?)(?:\.\d+)?\b|^Wave (\d+[a-z]?)/.exec(s);
  if (m) return `Wave ${m[1] ?? m[2]}`;
  if (/^Debug/i.test(s)) return 'Fixes';
  return 'Other changes';
};
const groups = new Map();
for (const s of subjects.reverse()) {
  const g = groupOf(s);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(s);
}
const date = new Date().toISOString().slice(0, 10);
const text = `## ${version} (${date})\n\n${[...groups]
  .map(([g, items]) => `### ${g}\n\n${items.map((i) => `- ${i}`).join('\n')}`)
  .join('\n\n')}\n`;
process.stdout.write(text);
if (process.argv.includes('--write')) {
  const head = '# Changelog\n\nWhat changed in each release of Aerolith Core, newest first.\n\n';
  const old = existsSync('CHANGELOG.md')
    ? readFileSync('CHANGELOG.md', 'utf8').replace(head, '')
    : '';
  writeFileSync('CHANGELOG.md', `${head}${text}\n${old}`);
}
