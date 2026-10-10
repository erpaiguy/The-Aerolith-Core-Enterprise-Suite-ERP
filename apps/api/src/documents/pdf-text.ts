// Reading the text of a PDF (docs/wave1-plan.md step 13 part 7) with pdf.js (pdfjs-dist, Apache-2.0), in a worker
// thread of its own: a large or hostile file costs that thread, never the API's event loop, and it is stopped when it
// takes too long or too much memory. Nothing is rendered and no script in the file runs (pdf.js does not run PDF
// JavaScript; eval is switched off too).
import { Worker } from 'node:worker_threads';

export interface PdfText {
  pages: number;
  text: string;
}

export class PdfTextError extends Error {
  constructor(
    message: string,
    /** Not worth trying again: the file is protected by a password or not a PDF pdf.js can read. */
    readonly final: boolean,
  ) {
    super(message);
  }
}

export const PDF_LIMITS = {
  maxPages: 500,
  maxChars: 2_000_000,
  timeoutMs: 120_000,
  maxHeapMb: 512,
};

// CommonJS run by the worker (eval), so the same code works from the TypeScript sources in tests and from dist/.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
// pdf.js looks for these browser classes when it loads; reading text never draws, so plain stand-ins do (they would
// otherwise come from a native canvas package, which is not installed).
class DOMMatrix {
  constructor(m) {
    const [a, b, c, d, e, f] = Array.isArray(m) && m.length === 6 ? m : [1, 0, 0, 1, 0, 0];
    Object.assign(this, { a, b, c, d, e, f, m11: a, m12: b, m21: c, m22: d, m41: e, m42: f, is2D: true });
  }
  multiplySelf() { return this; }
  preMultiplySelf() { return this; }
  translateSelf() { return this; }
  scaleSelf() { return this; }
  invertSelf() { return this; }
  translate() { return new DOMMatrix(); }
  scale() { return new DOMMatrix(); }
  multiply() { return new DOMMatrix(); }
  inverse() { return new DOMMatrix(); }
}
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.Path2D ??= class Path2D {};
globalThis.ImageData ??= class ImageData {};
(async () => {
  const pdfjs = await import(pathToFileURL(workerData.pdfjs).href);
  const data = new Uint8Array(await readFile(workerData.path));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  }).promise;
  const pages = Math.min(doc.numPages, workerData.maxPages);
  const parts = [];
  let length = 0;
  for (let i = 1; i <= pages && length < workerData.maxChars; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) if ('str' in item) line += item.str + (item.hasEOL ? '\\n' : ' ');
    parts.push(line.replace(/[ \\t]+\\n/g, '\\n').trim());
    length += line.length;
    page.cleanup();
  }
  const numPages = doc.numPages;
  await doc.destroy();
  parentPort.postMessage({ ok: true, pages: numPages, text: parts.join('\\n\\n') });
})().catch((err) => {
  parentPort.postMessage({
    ok: false,
    name: err && err.name,
    message: String((err && err.message) || err),
  });
});
`;

/** The text of a PDF on this server's disk: every page up to the limits, NUL characters removed. */
export function readPdfText(path: string, limits = PDF_LIMITS): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: {
        path,
        pdfjs: require.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
        maxPages: limits.maxPages,
        maxChars: limits.maxChars,
      },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfTextError('took too long to read', false))),
      limits.timeoutMs,
    );
    worker.on(
      'message',
      (
        m:
          { ok: true; pages: number; text: string } | { ok: false; name?: string; message: string },
      ) =>
        finish(() => {
          if (m.ok)
            resolve({
              pages: m.pages,
              text: m.text.replace(/\0/g, '').slice(0, limits.maxChars),
            });
          else if (m.name === 'PasswordException')
            reject(new PdfTextError('protected by a password', true));
          else if (m.name === 'InvalidPDFException')
            reject(new PdfTextError('not a PDF that can be read', true));
          else reject(new PdfTextError(m.message.slice(0, 300), false));
        }),
    );
    worker.on('error', (err) =>
      finish(() =>
        reject(
          new PdfTextError(
            /memory/i.test(err.message) ? 'too large to read' : err.message.slice(0, 300),
            /memory/i.test(err.message),
          ),
        ),
      ),
    );
    worker.on('exit', (code) =>
      finish(() => reject(new PdfTextError(`stopped (exit ${code})`, false))),
    );
  });
}
