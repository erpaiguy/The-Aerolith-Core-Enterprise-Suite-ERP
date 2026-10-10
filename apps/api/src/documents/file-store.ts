// Where document bytes live (docs/04-features.md P8, docs/wave1-plan.md step 10). Every file is named by its SHA-256,
// so a version row points at its exact content, the same file uploaded twice is kept once, and nothing is ever
// overwritten. An upload is received into a temporary file first (hashed and size-checked as it streams, then
// scanned), and only kept once it passes; the database row is written after that, so a row never points at a file
// that is not there.
//
// One implementation today: a folder on the server, one sub-folder per tenant. Tenants whose database is in their own
// Supabase project are meant to keep files in that project's Storage; that store is not built until the Supabase
// connection can be verified (see DocumentsService.store).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const STORAGE_KEY = /^[0-9a-f]{64}$/;
const HEAD_BYTES = 16;

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`larger than ${maxBytes} bytes`);
  }
}

export class FileMissingError extends Error {}

/** A file received and hashed, waiting to be kept. */
export interface StagedFile {
  /** Temporary file on this server's disk. */
  path: string;
  size: number;
  sha256: string;
  /** The first bytes, to recognise the file's type. */
  head: Buffer;
}

export interface FileStore {
  stage(source: Readable, maxBytes: number): Promise<StagedFile>;
  /** Keeps a staged file under its hash (nothing to do when that content is already kept); returns the key. */
  commit(file: StagedFile): Promise<string>;
  discard(file: StagedFile): Promise<void>;
  open(key: string): Promise<Readable>;
  /**
   * Removes a kept file no version uses any more (the caller has checked), unless it was kept or reused within
   * `minAgeMs`: an upload of the same bytes may be about to write its row.
   */
  remove(key: string, minAgeMs: number, now?: number): Promise<boolean>;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private pathOf(key: string) {
    if (!STORAGE_KEY.test(key)) throw new Error('invalid storage key');
    return join(this.root, key.slice(0, 2), key);
  }

  async stage(source: Readable, maxBytes: number): Promise<StagedFile> {
    const tmpDir = join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const path = join(tmpDir, randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    const head: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new FileTooLargeError(maxBytes));
        if (headLen < HEAD_BYTES) {
          head.push(chunk.subarray(0, HEAD_BYTES - headLen));
          headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      // flush: the bytes are on disk before the file is kept under its final name.
      await pipeline(source, meter, createWriteStream(path, { flush: true }));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { path, size, sha256: hash.digest('hex'), head: Buffer.concat(head) };
  }

  async commit(file: StagedFile): Promise<string> {
    const dest = this.pathOf(file.sha256);
    const kept = await stat(dest).catch(() => null);
    if (kept) {
      await rm(file.path, { force: true });
      // Reused: marked recent, so a purge of an older document with the same bytes leaves the file alone.
      const at = new Date();
      await utimes(dest, at, at).catch(() => undefined);
      return file.sha256;
    }
    await mkdir(dirname(dest), { recursive: true });
    await rename(file.path, dest); // same file system: atomic
    return file.sha256;
  }

  async discard(file: StagedFile): Promise<void> {
    await rm(file.path, { force: true });
  }

  async open(key: string): Promise<Readable> {
    const path = this.pathOf(key);
    if (!(await stat(path).catch(() => null))) throw new FileMissingError(key);
    return createReadStream(path);
  }

  async remove(key: string, minAgeMs: number, now = Date.now()): Promise<boolean> {
    const path = this.pathOf(key);
    const s = await stat(path).catch(() => null);
    if (!s || now - s.mtimeMs < minAgeMs) return false;
    await rm(path, { force: true });
    return true;
  }

  /** Removes temporary files left by uploads that never finished (a crash or a dropped connection). */
  async sweep(olderThanMs: number, now = Date.now()): Promise<number> {
    const tmpDir = join(this.root, '.tmp');
    let removed = 0;
    for (const name of await readdir(tmpDir).catch(() => [] as string[])) {
      const s = await stat(join(tmpDir, name)).catch(() => null);
      if (s && now - s.mtimeMs > olderThanMs) {
        await rm(join(tmpDir, name), { force: true });
        removed++;
      }
    }
    return removed;
  }
}

/** Types the browser can show safely (never HTML or SVG, which could run script). */
export const PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
]);

const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mpp: 'application/vnd.ms-project',
  xer: 'application/octet-stream',
};

/**
 * The type of an uploaded file. PDFs and images are recognised by their first bytes, never by name alone, because
 * they are the types shown inside the app; everything else goes by extension and is only ever downloaded.
 */
export function fileType(head: Buffer, name: string): string {
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** A file name as it may be kept: no folders, no control characters, at most 255 characters with its extension. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length <= 255) return name;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? '';
  return name.slice(0, 255 - ext.length).trimEnd() + ext;
}
