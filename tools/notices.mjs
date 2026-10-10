// Third-party notices and SBOM (docs/licensing-policy.md §3.2): for one product, every production dependency with its
// licence text and NOTICE file, as THIRD_PARTY_NOTICES.txt, and the same list as a CycloneDX 1.5 SBOM
// (sbom.cdx.json). Apache-2.0 §4(d) requires the NOTICE file to travel with the product; MIT, BSD and ISC require the
// copyright and licence text. Built into each product: the API image, the web and owner bundles, the desktop installer.
//
//   node tools/notices.mjs --product "Aerolith Core web" --filter "@aerolith/web..." --out apps/web/dist
//   [--add electron:apps/desktop]   also a package that is not a production dependency but ships (Electron)
//
// Deterministic (sorted, no timestamps), so the files only change when the dependencies do.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
};
const product = opt('product')[0] ?? 'Aerolith Core';
const filters = opt('filter');
const outDir = opt('out')[0];
if (!outDir || filters.length === 0) {
  console.error(
    'usage: notices.mjs --product <name> --filter <pnpm filter>... --out <dir> [--add pkg:dir]',
  );
  process.exit(2);
}

const isOwn = (name) => name.startsWith('@aerolith/') || name === 'aerolith-core';

/** name@version -> { name, version, license, homepage, path } */
function collect() {
  const filterArgs = filters.flatMap((f) => ['--filter', f]);
  const out = execFileSync('pnpm', [...filterArgs, 'licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(out || '{}');
  const pkgs = new Map();
  for (const [license, list] of Object.entries(byLicense))
    for (const p of list)
      p.versions.forEach((version, i) => {
        if (isOwn(p.name)) return;
        pkgs.set(`${p.name}@${version}`, {
          name: p.name,
          version,
          license,
          homepage: p.homepage ?? '',
          path: p.paths[i] ?? p.paths[0],
        });
      });
  for (const spec of opt('add')) {
    const [name, from] = spec.split(':');
    const req = createRequire(join(resolve(from ?? '.'), 'package.json'));
    const pj = req.resolve(`${name}/package.json`);
    const meta = JSON.parse(readFileSync(pj, 'utf8'));
    pkgs.set(`${name}@${meta.version}`, {
      name,
      version: meta.version,
      license: typeof meta.license === 'string' ? meta.license : 'UNKNOWN',
      homepage: meta.homepage ?? '',
      path: dirname(pj),
    });
  }
  return [...pkgs.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

// The standard texts, for packages published under them without a licence file (their copyright line comes from
// the package's author field).
const STANDARD = {
  MIT: (who) => `MIT License

Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: (who) => `ISC License

Copyright (c) ${who}

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

function author(dir) {
  try {
    const a = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).author;
    return (typeof a === 'string' ? a : a?.name) || 'the authors';
  } catch {
    return 'the authors';
  }
}

/** The package's own LICENSE/COPYING and NOTICE files, as shipped in it. */
function texts(dir) {
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { licence: null, notice: null };
  }
  const read = (re) => {
    const f = files.filter((x) => re.test(x)).sort()[0];
    return f ? readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() : null;
  };
  return {
    licence: read(/^(licen[sc]e|copying|unlicen[sc]e)([-.](md|txt|markdown|mit|bsd|apache2?))?$/i),
    notice: read(/^notice(\.(md|txt))?$/i),
  };
}

const pkgs = collect();
const rule = '-'.repeat(78);
let txt = `THIRD-PARTY SOFTWARE NOTICES: ${product}\n\n`;
txt += `${product} includes the open-source software listed below, used under the licence named for each. The\n`;
txt += `licence text and any NOTICE file shipped with each package are reproduced in full. No package below has been\n`;
txt += `modified.\n\n${pkgs.length} packages.\n\n`;
const missing = [];
for (const p of pkgs) {
  const t = texts(p.path);
  txt += `${rule}\n${p.name} ${p.version}\nLicence: ${p.license}\n`;
  if (p.homepage) txt += `Home: ${p.homepage}\n`;
  if (t.notice) txt += `\nNOTICE:\n\n${t.notice}\n`;
  if (t.licence) txt += `\n${t.licence}\n`;
  else {
    missing.push(`${p.name}@${p.version}`);
    const standard = STANDARD[p.license];
    txt += standard
      ? `\nThe package ships no licence file; it is published under the ${p.license} licence, whose text is:\n\n${standard(author(p.path))}\n`
      : `\nThe package ships no licence file. It is published under the ${p.license} licence; the standard text of\nthat licence applies (https://spdx.org/licenses/${encodeURIComponent(p.license)}.html).\n`;
  }
  txt += '\n';
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: { component: { type: 'application', name: product } },
  components: pkgs.map((p) => ({
    type: 'library',
    name: p.name,
    version: p.version,
    purl: `pkg:npm/${p.name.startsWith('@') ? `%40${p.name.slice(1)}` : p.name}@${p.version}`,
    licenses: [
      /\s(AND|OR)\s|[()]/.test(p.license)
        ? { expression: p.license }
        : { license: { id: p.license } },
    ],
  })),
};

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), txt);
writeFileSync(join(outDir, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
console.log(
  `${product}: ${pkgs.length} packages, ${pkgs.filter((p) => texts(p.path).notice).length} NOTICE files, ` +
    `${missing.length} without a licence file -> ${outDir}`,
);
