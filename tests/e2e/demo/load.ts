// Reads the demo's sign-ins: the JSON the seeder writes with DEMO_OUT, or the printed text saved with
// `... demo-seed.js --demo > demo-credentials.txt` (DEMO_CREDENTIALS), so the walkthrough runs against any install.
import { readFileSync } from 'node:fs';

export interface Demo {
  licenceKey: string;
  tenantId: string;
  admin: { email: string; password: string; secret: string };
  staff: { username: string; password: string; role: string }[];
  portal: { email: string; password: string; kind: string }[];
  paths: string[];
}

function fromText(text: string): Demo {
  const lines = text.replace(/\r/g, '').split('\n');
  const after = (heading: string) => {
    const i = lines.findIndex((l) => l.startsWith(heading));
    const out: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (!l.startsWith('  ')) break;
      out.push(l.trim());
    }
    return { line: lines[i] ?? '', rows: out };
  };
  const admin = after('Tenant admin');
  const [, email, , password] = admin.rows[0]!.split(/\s+/);
  const secret = admin.rows.find((r) => r.startsWith('authenticator secret'))!.split(/\s+/)[2]!;
  const portal = after('Portal (');
  return {
    licenceKey: /AERO(?:-[0-9A-Z]{5}){4}/.exec(text)![0],
    tenantId: /\/portal\/([0-9a-f-]{36})/.exec(portal.line)![1]!,
    admin: { email: email!, password: password!, secret },
    staff: after('Staff (').rows.map((r) => {
      const [username, pw, role] = r.split(/\s+/);
      return { username: username!, password: pw!, role: role! };
    }),
    portal: portal.rows.map((r) => {
      const [e, pw, kind] = r.split(/\s+/);
      return { email: e!, password: pw!, kind: kind! };
    }),
    paths: (/^Detail pages[^:]*: (.*)$/m.exec(text)?.[1] ?? '').split(' ').filter(Boolean),
  };
}

export function loadDemo(): Demo {
  if (process.env.DEMO_CREDENTIALS)
    return fromText(readFileSync(process.env.DEMO_CREDENTIALS, 'utf8'));
  return JSON.parse(
    readFileSync(process.env.DEMO_JSON ?? '../../demo-credentials.json', 'utf8'),
  ) as Demo;
}
