// Wave 0 benchmark runner. Usage: DATABASE_URL=postgres://... pnpm --filter @aerolith/bench bench
// Drops and recreates the `est` and `sched` schemas, so it refuses to run against a database without "bench" in its name.
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { importBoq, importSchedule, itemCount, SHAPE_1M, SHAPE_200K } from './generate.js';
import { renderReport, type BenchResults } from './report.js';
import {
  collapsedWindows,
  copyRevision,
  editQuantities,
  insertBetween,
  openFirstWindow,
  randomItems,
  recalculateSchedule,
  scrollWindows,
  searchDescriptions,
  sortByAmount,
} from './scenarios.js';
import { indexSql, schemaSql } from './schema.js';
import { one, timeIt } from './stats.js';

const url = process.env.DATABASE_URL ?? 'postgres://bench:bench@127.0.0.1:5432/aerolith_bench';
const log = (msg: string) => process.stdout.write(`[bench] ${msg}\n`);

async function main(): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const { db } = one(await sql<{ db: string }[]>`SELECT current_database() AS db`);
  if (!db.includes('bench'))
    throw new Error(`refusing to run against database "${db}" (name must contain "bench")`);

  const { version } = one(
    await sql<{ version: string }[]>`SELECT current_setting('server_version') AS version`,
  );
  const { sb } = one(await sql<{ sb: string }[]>`SELECT current_setting('shared_buffers') AS sb`);
  const { wm } = one(await sql<{ wm: string }[]>`SELECT current_setting('work_mem') AS wm`);

  log('creating schema and indexes');
  await sql.unsafe(schemaSql());
  await sql.unsafe(indexSql);

  const newBoq = async (name: string) =>
    (await sql<{ id: string }[]>`INSERT INTO est.boq (name) VALUES (${name}) RETURNING id`)[0]!.id;

  log('importing 4 x 200k-line BOQs (background tenant data)');
  const smallImports: number[] = [];
  for (let i = 0; i < 4; i++) {
    const id = await newBoq(`Tower ${i + 1}`);
    smallImports.push((await timeIt(() => importBoq(sql, id, SHAPE_200K, 100 + i))).ms);
  }

  const sizeOf = async () =>
    Number(
      (
        await sql<{ bytes: string }[]>`
      SELECT (sum(pg_total_relation_size(c.oid)))::text AS bytes FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'est' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'boq_node%'`
      )[0]!.bytes,
    );

  const before = await sizeOf();
  log('importing the 1M-line BOQ (timed)');
  const bigBoq = await newBoq('Mega township');
  const bigImport = await timeIt(() => importBoq(sql, bigBoq, SHAPE_1M, 1));
  await sql`ANALYZE est.boq_node`;
  await sql`ANALYZE est.boq_node_text`;
  const after = await sizeOf();

  log('measuring windows, search, sort, edits');
  const items = await randomItems(sql, bigBoq, 400);
  const starts = items.slice(0, 200).map((r) => r.sort_key);
  const firstWindow = await openFirstWindow(sql, bigBoq);
  const scroll = await scrollWindows(sql, bigBoq, starts);
  const collapsed = await collapsedWindows(sql, bigBoq, starts.slice(0, 100));
  const search = await searchDescriptions(sql, bigBoq);
  const sort = await sortByAmount(sql, bigBoq);
  const edit = await editQuantities(sql, bigBoq, items.slice(0, 200));
  const insert = await insertBetween(sql, bigBoq, items.slice(200, 300));

  log('copying a revision of the 1M-line BOQ');
  const revision = await copyRevision(sql, bigBoq);

  log('generating and recalculating a 50k-activity schedule');
  const { id: planId } = one(
    await sql<{ id: string }[]>`INSERT INTO sched.plan (kind) VALUES ('micro') RETURNING id`,
  );
  await importSchedule(sql, planId, 50_000, 3);
  await sql`ANALYZE sched.activity`;
  await sql`ANALYZE sched.relation`;
  const cpmFirst = await recalculateSchedule(sql, planId);
  const cpm = await recalculateSchedule(sql, planId);

  const results: BenchResults = {
    environment: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      postgres: version,
      sharedBuffers: sb,
      workMem: wm,
      node: process.version,
      ranAt: new Date().toISOString(),
    },
    bigBoqItems: itemCount(SHAPE_1M),
    smallImportsMs: smallImports,
    importMs: bigImport.ms,
    importedRows: bigImport.value,
    bytesFor1M: after - before,
    totalBoqBytes: after,
    firstWindow,
    scroll,
    collapsed,
    search,
    sort,
    edit,
    insert,
    revisionMs: revision.ms,
    cpmFirst,
    cpm,
  };

  const outDir = new URL('../../../docs/benchmarks/', import.meta.url);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL('wave0-benchmark.md', outDir), renderReport(results));
  writeFileSync(new URL('wave0-benchmark.json', outDir), JSON.stringify(results, null, 2) + '\n');
  log('report written to docs/benchmarks/wave0-benchmark.md');
  await sql.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
