// Thumbnails of tender documents (docs/wave1-plan.md step 13 part 7), made in the browser that already has the file:
// the uploader's, or anyone's who opens its preview. The first page of a PDF (pdf.js, Apache-2.0, loaded only when
// needed) or a small copy of an image, sent to the server as a picture of at most 200 KB. The server renders nothing.
import { api } from '../api/client';

const WIDTH = 240;
const MAX_BYTES = 200 * 1024;
/** Larger files are not opened just for a thumbnail. */
const MAX_SOURCE = { pdf: 50 * 1024 * 1024, image: 30 * 1024 * 1024 };
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type ThumbnailSource = 'pdf' | 'image' | null;

export function thumbnailSource(mime: string, name = ''): ThumbnailSource {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (IMAGES.has(mime) || /\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return null;
}

async function pdfCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas;
  } finally {
    await doc.destroy();
  }
}

async function imageCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** A thumbnail of the file, or null when it is not a PDF or image, too large, or cannot be drawn. */
export async function makeThumbnail(file: Blob, source: ThumbnailSource): Promise<Blob | null> {
  if (!source || file.size > MAX_SOURCE[source]) return null;
  try {
    const canvas = source === 'pdf' ? await pdfCanvas(file) : await imageCanvas(file);
    // WebP where the browser makes it (it falls back to PNG otherwise), then a smaller JPEG if needed.
    for (const [type, q] of [
      ['image/webp', 0.8],
      ['image/jpeg', 0.7],
      ['image/jpeg', 0.5],
    ] as const) {
      const blob = await toBlob(canvas, type, q);
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    return null;
  } catch {
    return null;
  }
}

/** Makes and keeps the thumbnail of a version; quietly does nothing when it cannot. */
export async function saveThumbnail(
  documentId: string,
  versionNo: number,
  file: Blob,
  source: ThumbnailSource,
): Promise<boolean> {
  const thumb = await makeThumbnail(file, source);
  if (!thumb) return false;
  const ext = thumb.type === 'image/webp' ? 'webp' : thumb.type === 'image/png' ? 'png' : 'jpg';
  try {
    await api.upload(
      `/api/tenant/documents/${documentId}/versions/${versionNo}/thumbnail`,
      new File([thumb], `thumbnail.${ext}`, { type: thumb.type }),
    );
    return true;
  } catch {
    return false;
  }
}
