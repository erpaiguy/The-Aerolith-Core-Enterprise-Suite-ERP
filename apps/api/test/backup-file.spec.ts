import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BackupWriter, readBackup, type Event } from '../src/backup/backup-file.js';

const collect = async (s: PassThrough) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

describe('the backup file (step 8g.2)', () => {
  const write = async () => {
    const out = new PassThrough();
    const done = collect(out);
    const w = new BackupWriter(out);
    await w.header({
      createdAt: '2026-10-17T00:00:00Z',
      tenantId: 't1',
      migrations: ['0001_a.sql'],
      sequences: [{ name: 'acc.party_code', value: '42', called: true }],
    });
    await w.table(
      'platform.entity',
      ['name', 'n'],
      2,
      Readable.from([Buffer.from('a,1\n'), Buffer.from('b,"x\ny"\n')]),
    );
    await w.table('acc.voucher', ['id'], 0, Readable.from([]));
    await w.finish();
    return done;
  };

  it('writes and reads back every table, in chunks small or large', async () => {
    const file = await write();
    for (const size of [1, 7, 4096]) {
      const pieces: Buffer[] = [];
      for (let i = 0; i < file.length; i += size) pieces.push(file.subarray(i, i + size));
      const events: Event[] = [];
      for await (const e of readBackup(Readable.from(pieces))) events.push(e);
      const csv = Buffer.concat(
        events.flatMap((e) =>
          e.kind === 'chunk' && e.table === 'platform.entity' ? [e.bytes] : [],
        ),
      ).toString();
      expect(csv).toBe('a,1\nb,"x\ny"\n');
      expect(events.map((e) => e.kind)).toEqual([
        'header',
        'start',
        'chunk',
        'chunk',
        'end',
        'start',
        'end',
        'trailer',
      ]);
      expect(events.find((e) => e.kind === 'start')).toEqual({
        kind: 'start',
        table: 'platform.entity',
        cols: ['name', 'n'],
      });
      const t = events.at(-1) as Extract<Event, { kind: 'trailer' }>;
      expect(t.tables.map((x) => [x.t, x.rows])).toEqual([
        ['platform.entity', 2],
        ['acc.voucher', 0],
      ]);
    }
  });

  it('refuses a damaged or cut-short file', async () => {
    const file = await write();
    const bad = Buffer.from(file);
    bad[bad.indexOf('a,1') + 2] = 0x39; // a,1 becomes a,9
    await expect(async () => {
      for await (const _ of readBackup(Readable.from([bad]))) void _;
    }).rejects.toThrow(/damaged/);
    await expect(async () => {
      for await (const _ of readBackup(Readable.from([file.subarray(0, file.length - 20)]))) void _;
    }).rejects.toThrow(/cut short|middle/);
  });
});
