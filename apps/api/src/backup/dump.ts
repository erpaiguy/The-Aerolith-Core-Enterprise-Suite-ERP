// Dump and restore of one tenant database in the backup file format (docs/wave8-plan.md step 8g.2). The dump reads
// every table in one repeatable-read snapshot as the owner role; the restore loads a freshly migrated database with
// triggers off (so foreign keys and audit triggers do not fire on rows that were already checked), then proves it:
// each table's row count and the hash of its contents read back must match the backup.
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { Sql, TransactionSql } from 'postgres';
import { OWNER_GROUP } from '../provisioning/bootstrap.js';
import { BackupWriter, readBackup, type Header, type TableEnd } from './backup-file.js';

/** Quotes "schema.table" or a column name for SQL; names come from the catalogue or a backup file. */
export const qname = (name: string) =>
  name
    .split('.')
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join('.');

const SKIP_SCHEMAS = ['pg_catalog', 'information_schema', 'aerolith_meta', 'pg_toast'];

async function tablesOf(tx: TransactionSql) {
  const rows = await tx<{ name: string; cols: string[] }[]>`
    SELECT n.nspname || '.' || c.relname AS name,
      array(SELECT a.attname::text FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        ORDER BY a.attnum) AS cols
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname <> ALL(${SKIP_SCHEMAS}) AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1`;
  return rows;
}

export interface DumpResult {
  tables: TableEnd[];
  rows: number;
}

/** Writes the whole database to `out` (ended when done). `sql` is an owner connection. */
export async function dumpDatabase(
  sql: Sql,
  out: Writable,
  meta: { tenantId: string; createdAt: string },
): Promise<DumpResult> {
  const w = new BackupWriter(out);
  const tables = await sql.begin('isolation level repeatable read read only', async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${OWNER_GROUP}`);
    const migrations = (
      await tx<{ name: string }[]>`SELECT name FROM aerolith_meta.schema_migration ORDER BY name`
    ).map((r) => r.name);
    const sequences = await tx<{ name: string; value: string; called: boolean }[]>`
      SELECT schemaname || '.' || sequencename AS name,
        coalesce(last_value, start_value)::text AS value, last_value IS NOT NULL AS called
      FROM pg_sequences WHERE schemaname <> ALL(${SKIP_SCHEMAS}) ORDER BY 1`;
    await w.header({ ...meta, migrations, sequences });
    for (const t of await tablesOf(tx)) {
      const [c] = await tx.unsafe<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM ${qname(t.name)}`,
      );
      const csv = await tx
        .unsafe(`COPY ${qname(t.name)} (${t.cols.map(qname).join(', ')}) TO STDOUT (FORMAT csv)`)
        .readable();
      await w.table(t.name, t.cols, Number(c!.n), csv);
    }
    return w.finish();
  });
  return { tables, rows: tables.reduce((s, t) => s + t.rows, 0) };
}

export interface RestoreResult {
  header: Header;
  tables: number;
  rows: number;
  /** Anything that did not match; empty when the restore is proven. */
  problems: string[];
}

/**
 * Loads a backup into `sql`, a superuser connection to a database already migrated to at least the backup's
 * migrations. Everything in it is replaced. One transaction: a failure leaves the database as it was.
 */
export async function restoreDatabase(
  sql: Sql,
  input: AsyncIterable<Buffer | string>,
): Promise<RestoreResult> {
  const problems: string[] = [];
  let header: Header | null = null;
  let rows = 0;
  const ends: (TableEnd & { cols: string[] })[] = [];
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    const have = new Map((await tablesOf(tx)).map((t) => [t.name, t.cols]));
    let copy: Writable | null = null;
    let current: { table: string; cols: string[] } | null = null;
    for await (const e of readBackup(input)) {
      if (e.kind === 'header') {
        header = e.header;
        const applied = new Set(
          (await tx<{ name: string }[]>`SELECT name FROM aerolith_meta.schema_migration`).map(
            (r) => r.name,
          ),
        );
        const missing = e.header.migrations.filter((m) => !applied.has(m));
        if (missing.length)
          throw new Error(
            `The database is older than the backup: migrate it first (missing ${missing.join(', ')}).`,
          );
        if (have.size)
          await tx.unsafe(`TRUNCATE ${[...have.keys()].map(qname).join(', ')} CASCADE`);
      } else if (e.kind === 'start') {
        const cols = have.get(e.table);
        if (!cols) throw new Error(`The backup has a table this version does not: ${e.table}.`);
        const unknown = e.cols.filter((c) => !cols.includes(c));
        if (unknown.length)
          throw new Error(
            `The backup's ${e.table} has columns this version does not: ${unknown.join(', ')}.`,
          );
        current = { table: e.table, cols: e.cols };
        copy = await tx
          .unsafe(
            `COPY ${qname(e.table)} (${e.cols.map(qname).join(', ')}) FROM STDIN (FORMAT csv)`,
          )
          .writable();
      } else if (e.kind === 'chunk') {
        const c = copy!;
        if (!c.write(e.bytes)) await new Promise<void>((ok) => c.once('drain', () => ok()));
      } else if (e.kind === 'end') {
        const c = copy!;
        await new Promise<void>((ok, fail) => {
          c.once('error', fail);
          c.end(() => ok());
        });
        copy = null;
        const [n] = await tx.unsafe<{ n: string }[]>(
          `SELECT count(*)::text AS n FROM ${qname(e.end.t)}`,
        );
        if (Number(n!.n) !== e.end.rows)
          problems.push(`${e.end.t}: ${n!.n} rows restored, the backup has ${e.end.rows}.`);
        rows += e.end.rows;
        ends.push({ ...e.end, cols: current!.cols });
        current = null;
      } else if (e.kind === 'trailer') {
        for (const s of header!.sequences)
          await tx`SELECT setval(${s.name}::regclass, ${s.value}::bigint, ${s.called})`;
        // Read every table back and compare its hash with the backup's.
        for (const t of ends) {
          const back = await tx
            .unsafe(`COPY ${qname(t.t)} (${t.cols.map(qname).join(', ')}) TO STDOUT (FORMAT csv)`)
            .readable();
          const hash = createHash('sha256');
          for await (const chunk of back) hash.update(chunk as Buffer);
          if (hash.digest('hex') !== t.sha256) problems.push(`${t.t}: the restored rows differ.`);
        }
      }
    }
  });
  if (!header) throw new Error('The backup has no header.');
  return { header, tables: ends.length, rows, problems };
}
