// The document file store, type recognition and the virus-scan hook (src/documents), without a database: files
// named by content, the size limit, nothing half-written left behind, and clamd's replies (a fake daemon).
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanTags, versionedName } from '../src/documents/documents.service.js';
import {
  FileMissingError,
  FileTooLargeError,
  LocalFileStore,
  cleanFileName,
  fileType,
} from '../src/documents/file-store.js';
import { clamdScan, parseReply } from '../src/documents/scanner.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const chunks = (b: Buffer, size: number) =>
  Readable.from(
    Array.from({ length: Math.ceil(b.length / size) }, (_, i) =>
      b.subarray(i * size, (i + 1) * size),
    ),
  );

describe('local file store', () => {
  let root: string;
  let store: LocalFileStore;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'aerolith-docs-'));
    store = new LocalFileStore(root);
  });

  it('keeps a file under its SHA-256, once however often it is uploaded', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200_000, 7)]);
    const a = await store.stage(chunks(pdf, 16_384), 1_000_000);
    expect(a).toMatchObject({ size: pdf.length, sha256: sha(pdf) });
    expect(fileType(a.head, 'notice.pdf')).toBe('application/pdf');
    expect(await store.commit(a)).toBe(sha(pdf));
    const b = await store.stage(Readable.from([pdf]), 1_000_000);
    await store.commit(b);
    expect(await readdir(join(root, sha(pdf).slice(0, 2)))).toEqual([sha(pdf)]);
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
    const back: Buffer[] = [];
    for await (const c of await store.open(sha(pdf))) back.push(c as Buffer);
    expect(Buffer.concat(back).equals(pdf)).toBe(true);
  });

  it('stops a file over the limit and leaves nothing behind', async () => {
    await expect(store.stage(chunks(Buffer.alloc(5000, 1), 1000), 4096)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
    const exact = await store.stage(Readable.from([Buffer.alloc(4096, 2)]), 4096);
    expect(exact.size).toBe(4096);
    await store.discard(exact);
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  it('refuses keys that are not hashes, and says when a file is missing', async () => {
    await expect(store.open('../../etc/passwd')).rejects.toThrow('invalid storage key');
    await expect(store.open('a'.repeat(64))).rejects.toBeInstanceOf(FileMissingError);
  });

  it('sweeps temporary files left by uploads that never finished', async () => {
    const old = join(root, '.tmp', 'left-over');
    await writeFile(old, 'x');
    await utimes(old, new Date(Date.now() - 7 * 3600_000), new Date(Date.now() - 7 * 3600_000));
    await writeFile(join(root, '.tmp', 'in-progress'), 'y');
    expect(await store.sweep(6 * 3600_000)).toBe(1);
    expect(await readdir(join(root, '.tmp'))).toEqual(['in-progress']);
    expect(await readFile(join(root, '.tmp', 'in-progress'), 'utf8')).toBe('y');
  });
});

describe('file names and types', () => {
  it('recognises the types shown in the app by their first bytes, never by name alone', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(fileType(png, 'site.png')).toBe('image/png');
    expect(fileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'photo.JPG')).toBe('image/jpeg');
    expect(fileType(Buffer.from('<html><script>'), 'drawing.pdf')).toBe('application/octet-stream');
    expect(fileType(Buffer.from('<svg onload=x>'), 'logo.svg')).toBe('application/octet-stream');
    expect(fileType(Buffer.from('PK\x03\x04'), 'BOQ.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(fileType(Buffer.from('AC1032'), 'GA plan.dwg')).toBe('image/vnd.dwg');
  });

  it('keeps file names without folders or control characters, and at most 255 characters', () => {
    expect(cleanFileName('C:\\Users\\a\\NIT 04.pdf')).toBe('NIT 04.pdf');
    expect(cleanFileName('../../x/Drawing\u0007.pdf')).toBe('Drawing.pdf');
    const long = cleanFileName(`${'a'.repeat(300)}.xlsx`);
    expect(long).toHaveLength(255);
    expect(long.endsWith('.xlsx')).toBe(true);
  });

  it('names older versions apart, and tidies tags', () => {
    expect(versionedName('Drawing.pdf', 2, 3)).toBe('Drawing (v2).pdf');
    expect(versionedName('Drawing.pdf', 3, 3)).toBe('Drawing.pdf');
    expect(versionedName('README', 1, 2)).toBe('README (v1)');
    expect(cleanTags([' Structural ', 'structural', 'Rev  B', ''])).toEqual([
      'Structural',
      'Rev B',
    ]);
  });
});

describe('clamd scan', () => {
  let server: Server;
  let port: number;
  const received: Buffer[] = [];
  beforeAll(async () => {
    server = createServer((socket) => {
      const parts: Buffer[] = [];
      socket.on('data', (d) => {
        parts.push(d);
        const all = Buffer.concat(parts);
        // The stream ends with a zero length after the command.
        if (all.length >= 14 && all.subarray(-4).equals(Buffer.alloc(4))) {
          received.push(all);
          const infected = all.includes(Buffer.from('EICAR'));
          socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends the file in length-prefixed chunks and reads the verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aerolith-scan-'));
    await writeFile(join(dir, 'clean.pdf'), Buffer.alloc(150_000, 1));
    await writeFile(join(dir, 'bad.pdf'), Buffer.from('X5O!P%@AP EICAR test'));
    const opts = { host: '127.0.0.1', port, timeoutMs: 5000 };
    expect(await clamdScan(join(dir, 'clean.pdf'), opts)).toEqual({ status: 'clean' });
    expect(received[0]!.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(received[0]!.readUInt32BE(10)).toBe(65_536);
    expect(await clamdScan(join(dir, 'bad.pdf'), opts)).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('keeps the file unscanned when the scanner is down or refuses it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aerolith-scan-'));
    await writeFile(join(dir, 'a.pdf'), 'x');
    const down = await clamdScan(join(dir, 'a.pdf'), {
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 2000,
    });
    expect(down.status).toBe('not_scanned');
    expect(parseReply('INSTREAM size limit exceeded. ERROR\0', '')).toEqual({
      status: 'not_scanned',
      reason: 'the scanner said: INSTREAM size limit exceeded. ERROR',
    });
  });
});
