#!/usr/bin/env node
// Aerolith Core's Tally agent (docs/wave6-plan.md step 6). Runs on a PC on the company's LAN beside Tally Prime:
// asks the Aerolith server for vouchers not yet in Tally, posts each to Tally's HTTP server, and reports Tally's
// answer back. No dependencies: Node 20 or later. Licensed with the rest of Aerolith Core's code.
//
//   AEROLITH_URL=https://erp.example.in AEROLITH_KEY=aek1... AEROLITH_ENTITY=<company id> node agent.mjs
//   Optional: TALLY_URL (default http://localhost:9000), EVERY_MINUTES (default 5; 0 runs once and stops).
/* global fetch, setTimeout */

/** Tally's answer to an import: what it created or changed, and its first error. */
export function parseTallyReply(xml) {
  const n = (tag) => Number(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, 'i').exec(xml)?.[1] ?? 0);
  const line = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(xml)?.[1]?.trim() ?? '';
  return {
    created: n('CREATED'),
    altered: n('ALTERED'),
    errors: n('ERRORS'),
    message: line.slice(0, 500),
  };
}

/** One pass: everything pending, oldest first, one voucher per Tally import. Returns what happened. */
export async function syncOnce({
  server,
  key,
  entityId,
  tally,
  fetchImpl = fetch,
  log = console.log,
}) {
  const auth = { authorization: `Bearer ${key}` };
  const res = await fetchImpl(`${server}/api/v1/tally/pending?entityId=${entityId}&limit=100`, {
    headers: auth,
  });
  if (!res.ok) throw new Error(`Aerolith answered ${res.status}: ${await res.text()}`);
  const { vouchers } = await res.json();
  const results = [];
  for (const v of vouchers) {
    let reply;
    try {
      const t = await fetchImpl(tally, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8' },
        body: v.xml,
      });
      reply = await t.text();
    } catch (err) {
      throw new Error(
        `Tally is not reachable at ${tally}. Open Tally Prime with the company loaded and turn on its HTTP server ` +
          `(F1 > Settings > Connectivity). ${err instanceof Error ? err.message : ''}`,
        { cause: err },
      );
    }
    const r = parseTallyReply(reply);
    const ok = r.errors === 0 && r.created + r.altered > 0;
    results.push({
      voucherId: v.voucherId,
      ok,
      response: ok ? 'Created' : r.message || reply.slice(0, 500),
    });
    log(`${v.number}: ${ok ? 'in Tally' : `refused: ${r.message || 'see Tally'}`}`);
  }
  if (results.length) {
    const back = await fetchImpl(`${server}/api/v1/tally/results`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    if (!back.ok) throw new Error(`Aerolith did not take the results: ${back.status}`);
  }
  return results;
}

async function main() {
  const env = process.env;
  const need = (k) => {
    if (!env[k]) {
      console.error(`Set ${k}. See README.md.`);
      process.exit(2);
    }
    return env[k];
  };
  const options = {
    server: need('AEROLITH_URL').replace(/\/$/, ''),
    key: need('AEROLITH_KEY'),
    entityId: need('AEROLITH_ENTITY'),
    tally: env.TALLY_URL ?? 'http://localhost:9000',
  };
  const every = Number(env.EVERY_MINUTES ?? 5);
  for (;;) {
    try {
      const done = await syncOnce(options);
      console.log(`${new Date().toISOString()} ${done.length} voucher(s) sent.`);
    } catch (err) {
      console.error(`${new Date().toISOString()} ${err instanceof Error ? err.message : err}`);
    }
    if (!every) return;
    await new Promise((r) => setTimeout(r, every * 60_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
