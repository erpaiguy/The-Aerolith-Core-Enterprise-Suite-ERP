// A minimal Excel writer for the data grids (docs/wave9-plan.md step 9a.5): one sheet of plain values in a real .xlsx,
// with no dependency. The workbook is six small XML parts in a ZIP stored without compression (CRC-32 checked), which
// Excel, LibreOffice and exceljs all open. Text goes in as inline strings, numbers as numbers, dates as serial numbers
// with a date style; the first row is bold and stays in view.

export type XlsxValue = string | number | Date | null | undefined;

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// --- CRC-32 (IEEE, as ZIP uses it) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- ZIP with the STORE method ---
/** Packs files into a ZIP archive without compression. Names are ASCII paths. */
export function zipStore(
  files: { name: string; data: Uint8Array }[],
  when = new Date(),
): Uint8Array {
  const enc = new TextEncoder();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date =
    ((Math.max(when.getFullYear(), 1980) - 1980) << 9) |
    ((when.getMonth() + 1) << 5) |
    when.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, f.data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by
    cv.setUint16(6, 20, true); // needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes stay zero
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- the workbook ---
const esc = (s: string) =>
  s
    // XML 1.0 forbids most control characters; drop them rather than write a file Excel refuses.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A, B, … Z, AA, AB … */
export function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel's day number for a date as it reads on this device's calendar (1900 date system). */
export function excelSerial(d: Date): number {
  const wall = d.getTime() - d.getTimezoneOffset() * 60_000;
  return wall / 86_400_000 + 25569;
}

function cell(ref: string, v: XlsxValue, bold: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `<c r="${ref}" s="2"><v>${excelSerial(v)}</v></c>`;
  }
  if (typeof v === 'number' && Number.isFinite(v))
    return `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${v}</v></c>`;
  const text = String(v);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t${space}>${esc(text)}</t></is></c>`;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * The bytes of an .xlsx with one sheet. `rows[0]` is the header row when `header` is true (the default): bold, and
 * frozen at the top. `widths` are column widths in pixels.
 */
export function xlsxBytes(
  rows: XlsxValue[][],
  opts: { sheetName?: string; header?: boolean; widths?: number[] } = {},
): Uint8Array {
  const header = opts.header ?? true;
  const sheetName =
    (opts.sheetName ?? 'Sheet1')
      .replace(/[[\]:*?/\\]/g, ' ')
      .slice(0, 31)
      .trim() || 'Sheet1';
  const cols = opts.widths?.length
    ? `<cols>${opts.widths
        .map(
          (w, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.round(w / 7))}" customWidth="1"/>`,
        )
        .join('')}</cols>`
    : '';
  const pane =
    header && rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '';
  const data = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((v, ci) => cell(`${columnName(ci)}${ri + 1}`, v, header && ri === 0)).join('')}</row>`,
    )
    .join('');
  const sheet = `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">${pane}${cols}<sheetData>${data}</sheetData></worksheet>`;
  const styles = `${XML}<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd mmm yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `${XML}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
    { name: 'xl/styles.xml', data: enc.encode(styles) },
  ]);
}

/** The .xlsx as a Blob, ready to download. */
export function xlsxBlob(
  rows: XlsxValue[][],
  opts: { sheetName?: string; header?: boolean; widths?: number[] } = {},
): Blob {
  return new Blob([xlsxBytes(rows, opts) as BlobPart], { type: MIME });
}

/** Saves a Blob through a temporary <a download>. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
