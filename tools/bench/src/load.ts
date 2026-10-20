// Load test of the heaviest screens (docs/wave9-plan.md step 9b.5), against a running server with data in it — the
// demo company is the usual target:
//   node dist/load.js --api http://127.0.0.1:3300 --key <licence key> --user suresh --password <password>
// It activates a test device, signs in, then requests each list a screen opens, from several simultaneous "people",
// and prints how long the answers took (median, 95th and 99th percentile) and any that failed. No dependency: fetch.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

const PATHS = [
  '/api/tenant/inbox',
  '/api/tenant/projects',
  '/api/tenant/tenders',
  '/api/tenant/orders',
  '/api/tenant/parties',
  '/api/tenant/stores',
  '/api/tenant/people',
  '/api/tenant/accounts/vouchers',
  '/api/tenant/accounts/vendor-bills',
  '/api/tenant/accounts/payment-runs',
];

export const percentile = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
    : NaN;

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      key: { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      people: { type: 'string', default: '10' },
      rounds: { type: 'string', default: '5' },
    },
  });
  if (!values.api || !values.key || !values.user || !values.password)
    throw new Error('Give --api, --key, --user and --password.');
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${values.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aerolith-client': 'desktop' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const { token } = await post<{ token: string }>('/api/licences/activate', {
    key: values.key,
    deviceId: randomUUID(),
    platform: 'linux',
    label: 'Load test',
  });
  const login = await post<{ accessToken?: string; status: string }>('/api/auth/login', {
    entitlementToken: token,
    identifier: values.user,
    password: values.password,
    client: 'desktop',
  });
  if (!login.accessToken)
    throw new Error(`Sign-in did not finish (${login.status}): use a user without two-factor.`);
  const headers = { authorization: `Bearer ${login.accessToken}`, 'x-aerolith-client': 'desktop' };
  // The books are kept per company (entity); the accounts lists are asked for the first one, as the screens do.
  const companies = (await (
    await fetch(`${values.api}/api/tenant/companies`, { headers })
  ).json()) as { companies?: { id: string }[] };
  const entityId = companies.companies?.[0]?.id;
  const urlOf = (p: string) =>
    p.startsWith('/api/tenant/accounts/') && entityId ? `${p}?entityId=${entityId}` : p;

  const times = new Map<string, number[]>(PATHS.map((p) => [p, []]));
  const failures: string[] = [];
  const person = async () => {
    for (let r = 0; r < Number(values.rounds); r++)
      for (const p of PATHS) {
        const t0 = performance.now();
        const res = await fetch(`${values.api}${urlOf(p)}`, { headers });
        await res.arrayBuffer();
        times.get(p)!.push(performance.now() - t0);
        if (!res.ok) failures.push(`${p} ${res.status} ${res.headers.get('x-request-id') ?? ''}`);
      }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Number(values.people) }, person));
  const total = (performance.now() - t0) / 1000;

  const rows = [...times].map(([p, ms]) => {
    const s = [...ms].sort((a, b) => a - b);
    return {
      p,
      n: s.length,
      p50: percentile(s, 50),
      p95: percentile(s, 95),
      p99: percentile(s, 99),
    };
  });
  const all = rows.reduce((n, r) => n + r.n, 0);
  process.stdout.write(
    `${values.people} people × ${values.rounds} rounds × ${PATHS.length} lists = ${all} requests in ${total.toFixed(1)} s (${(all / total).toFixed(0)}/s)\n\n` +
      `| List | Requests | Median ms | 95% ms | 99% ms |\n| --- | ---: | ---: | ---: | ---: |\n` +
      rows
        .map(
          (r) =>
            `| ${r.p} | ${r.n} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.p99.toFixed(0)} |`,
        )
        .join('\n') +
      `\n\nFailed: ${failures.length}${failures.length ? `\n${failures.slice(0, 20).join('\n')}` : ''}\n`,
  );
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('load.js'))
  void main().catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  });
