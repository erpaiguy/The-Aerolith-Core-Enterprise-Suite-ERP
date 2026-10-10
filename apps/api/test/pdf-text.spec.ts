// Reading the text of PDFs in a worker thread (docs/wave1-plan.md step 13 part 7), and recognising thumbnails.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { thumbnailType } from '../src/documents/documents.service.js';
import { PDF_LIMITS, PdfTextError, readPdfText } from '../src/documents/pdf-text.js';
import { textPdf } from './helpers/pdf.js';

describe('readPdfText', () => {
  let dir: string;
  const file = async (name: string, bytes: Buffer) => {
    const p = join(dir, name);
    await writeFile(p, bytes);
    return p;
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aerolith-pdf-'));
  });

  it('reads every page, in order', async () => {
    const p = await file(
      'spec.pdf',
      textPdf('Cement OPC 53 grade to IS 269', 'Steel Fe 500D (TMT)'),
    );
    const r = await readPdfText(p);
    expect(r.pages).toBe(2);
    expect(r.text).toBe('Cement OPC 53 grade to IS 269\n\nSteel Fe 500D (TMT)');
  });

  it('stops at the page and character limits', async () => {
    const p = await file('long.pdf', textPdf('page one', 'page two', 'page three'));
    expect((await readPdfText(p, { ...PDF_LIMITS, maxPages: 2 })).text).toBe(
      'page one\n\npage two',
    );
    expect((await readPdfText(p, { ...PDF_LIMITS, maxChars: 5 })).text).toBe('page ');
  });

  it('gives up for good on a file that is not a readable PDF', async () => {
    const p = await file('bad.pdf', Buffer.from('%PDF-1.7\nnot really a PDF'));
    const err = await readPdfText(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfTextError);
    expect(err).toMatchObject({ final: true });
  });

  it('stops a read that takes too long', async () => {
    const p = await file('slow.pdf', textPdf('slow'));
    const err = await readPdfText(p, { ...PDF_LIMITS, timeoutMs: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'took too long to read', final: false });
  });
});

describe('thumbnailType', () => {
  it('recognises WebP, PNG and JPEG by their bytes, and nothing else', () => {
    expect(thumbnailType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(thumbnailType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(thumbnailType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(thumbnailType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(thumbnailType(Buffer.from('GIF89a'))).toBeNull();
  });
});
