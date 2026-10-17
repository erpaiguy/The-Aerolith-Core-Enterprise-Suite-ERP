// The tenant backup file (docs/wave8-plan.md step 8g.2): a gzip stream of every table's rows as Postgres CSV, read
// in one consistent snapshot, framed so it can be written and read back as a stream (a million-line BOQ never sits in
// memory). Plain Node (zlib, crypto), no extra dependency:
//
//   H <json>\n                 the header: format, version, when, the migrations and sequence values
//   T <json>\n                 a table begins: {"t":"schema.table","cols":[...]} (generated columns left out)
//   C <length>\n<bytes>        a chunk of the table's CSV
//   E <json>\n                 the table ends: {"t", "rows", "sha256"} (the hash of all its CSV bytes)
//   Z <json>\n                 the trailer: every table with its rows and hash
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';

export const FORMAT = 'aerolith-backup';
export const VERSION = 1;

export interface Header {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  tenantId: string;
  migrations: string[];
  sequences: { name: string; value: string; called: boolean }[];
}
export interface TableEnd {
  t: string;
  rows: number;
  sha256: string;
}
export type Event =
  | { kind: 'header'; header: Header }
  | { kind: 'start'; table: string; cols: string[] }
  | { kind: 'chunk'; table: string; bytes: Buffer }
  | { kind: 'end'; end: TableEnd }
  | { kind: 'trailer'; tables: TableEnd[] };

const line = (tag: string, body: unknown) => Buffer.from(`${tag} ${JSON.stringify(body)}\n`);

/** Writes one framed record, waiting when the stream asks it to. */
async function put(out: Writable, buf: Buffer) {
  if (!out.write(buf)) await new Promise<void>((ok) => out.once('drain', () => ok()));
}

export class BackupWriter {
  private readonly ends: TableEnd[] = [];
  constructor(private readonly out: Writable) {}

  header(h: Omit<Header, 'format' | 'version'>) {
    return put(this.out, line('H', { format: FORMAT, version: VERSION, ...h }));
  }

  /** One table: its CSV stream copied in chunks, with the rows counted in the same snapshot. */
  async table(name: string, cols: string[], rows: number, csv: AsyncIterable<Buffer | string>) {
    await put(this.out, line('T', { t: name, cols }));
    const hash = createHash('sha256');
    for await (const chunk of csv) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(b);
      await put(this.out, Buffer.concat([Buffer.from(`C ${b.length}\n`), b]));
    }
    const end = { t: name, rows, sha256: hash.digest('hex') };
    this.ends.push(end);
    await put(this.out, line('E', end));
  }

  async finish() {
    await put(this.out, line('Z', { tables: this.ends }));
    await new Promise<void>((ok, fail) =>
      this.out.end((err?: Error | null) => (err ? fail(err) : ok())),
    );
    return this.ends;
  }
}

/** Reads a backup stream (already gunzipped) as events, checking each table's hash as it goes. */
export async function* readBackup(input: AsyncIterable<Buffer | string>): AsyncGenerator<Event> {
  let buf = Buffer.alloc(0);
  let table: string | null = null;
  let hash = createHash('sha256');
  let need: number | null = null;
  const it = input[Symbol.asyncIterator]();
  const more = async () => {
    const r = await it.next();
    if (r.done) return false;
    buf = Buffer.concat([buf, Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value)]);
    return true;
  };
  for (;;) {
    if (need !== null) {
      while (buf.length < need)
        if (!(await more())) throw new Error('The backup ends in the middle of a table.');
      const bytes = buf.subarray(0, need);
      buf = buf.subarray(need);
      need = null;
      hash.update(bytes);
      yield { kind: 'chunk', table: table!, bytes: Buffer.from(bytes) };
      continue;
    }
    let nl = buf.indexOf(10);
    while (nl < 0) {
      if (!(await more())) {
        if (buf.length) throw new Error('The backup ends in the middle of a record.');
        throw new Error('The backup has no trailer: it was cut short.');
      }
      nl = buf.indexOf(10);
    }
    const text = buf.subarray(0, nl).toString('utf8');
    buf = buf.subarray(nl + 1);
    const tag = text.slice(0, 1);
    const body = text.slice(2);
    if (tag === 'C') {
      if (!table) throw new Error('A chunk outside a table.');
      need = Number(body);
      if (!Number.isInteger(need) || need < 0) throw new Error('A bad chunk length.');
      continue;
    }
    const json = JSON.parse(body) as Record<string, unknown>;
    if (tag === 'H') {
      if (json.format !== FORMAT) throw new Error('This is not an Aerolith backup.');
      if (Number(json.version) > VERSION)
        throw new Error('This backup is from a newer version of the app.');
      yield { kind: 'header', header: json as unknown as Header };
    } else if (tag === 'T') {
      table = String(json.t);
      hash = createHash('sha256');
      yield { kind: 'start', table, cols: (json.cols as string[] | undefined) ?? [] };
    } else if (tag === 'E') {
      const end = json as unknown as TableEnd;
      if (end.t !== table) throw new Error(`The backup's table ${end.t} ends out of place.`);
      if (hash.digest('hex') !== end.sha256)
        throw new Error(`The backup's table ${end.t} is damaged.`);
      table = null;
      yield { kind: 'end', end };
    } else if (tag === 'Z') {
      yield { kind: 'trailer', tables: (json.tables as TableEnd[]) ?? [] };
      return;
    } else throw new Error('The backup is damaged.');
  }
}
