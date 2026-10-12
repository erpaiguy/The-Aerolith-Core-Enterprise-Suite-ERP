// Stamping a PDF (docs/wave5-plan.md steps 4 and 5) with pdf-lib (MIT): a box on every page with a few lines and a QR
// code drawn as squares (qrcode, MIT, for the matrix only), so no image is embedded. Fonts are the standard
// Helvetica, so text outside Latin-1 is replaced.
import { BadRequestException } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

/** Helvetica's WinAnsi encoding takes Latin-1; anything else becomes "?". */
export const latin1 = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

export async function loadPdf(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes);
  } catch {
    throw new BadRequestException({
      code: 'pdf_unreadable',
      message: 'This PDF cannot be opened for stamping (it may be encrypted or damaged).',
    });
  }
}

/** Draws a QR code with its bottom-left corner at (x, y), `size` points square. */
export function drawQr(
  page: ReturnType<PDFDocument['getPages']>[number],
  text: string,
  x: number,
  y: number,
  size: number,
) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const m = size / n;
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++)
      if (qr.modules.data[row * n + col])
        page.drawRectangle({
          x: x + col * m,
          y: y + size - (row + 1) * m,
          width: m,
          height: m,
          color: rgb(0, 0, 0),
        });
}

/** A box at the top right of every page: the lines beside a QR. */
export async function stampPdf(
  bytes: Uint8Array,
  s: { lines: string[]; qr: string; warn: boolean },
): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const lines = s.lines.map(latin1);
  const size = 7;
  const qr = 48;
  const pad = 5;
  const textW = Math.max(
    ...lines.map((l, i) => (i === 0 ? bold : font).widthOfTextAtSize(l, size)),
  );
  const w = pad * 3 + qr + textW;
  const h = qr + pad * 2;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const x = Math.max(4, width - w - 12);
    const y = Math.max(4, height - h - 12);
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: rgb(1, 1, 1),
      borderColor: s.warn ? rgb(0.8, 0, 0) : rgb(0, 0, 0),
      borderWidth: 1,
      opacity: 0.95,
    });
    drawQr(page, s.qr, x + pad, y + pad, qr);
    lines.forEach((l, i) =>
      page.drawText(l, {
        x: x + pad * 2 + qr,
        y: y + h - pad - (i + 1) * (size + 4) + 2,
        size,
        font: i === 0 ? bold : font,
        color: s.warn && i === lines.length - 1 ? rgb(0.8, 0, 0) : rgb(0, 0, 0),
      }),
    );
  }
  return pdf.save();
}
