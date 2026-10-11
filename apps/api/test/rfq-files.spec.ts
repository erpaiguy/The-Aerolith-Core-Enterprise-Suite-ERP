// The enquiry workbook (src/rfq/rfq-files.ts) as vendors return it: answers left blank, rows copied into a fresh
// file, rates typed as text, notes and totals added under the lines.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { enquiryWorkbook, readQuoteWorkbook } from '../src/rfq/rfq-files.js';

const pack = () =>
  enquiryWorkbook({
    rfq: {
      id: '5d1c3c2e-9a51-4f0e-8a43-2f6d3f1c0a11',
      number: 'RFQ/2026-27/0004',
      title: 'Waterproofing',
      dueOn: '2026-10-20',
      terms: 'Ex-works rates are not accepted.',
    },
    owner: { label: 'Tender', number: 'TND/2026-27/0002', title: 'Hostel block' },
    vendor: { id: '0b0e8d4f-6c1a-4f5e-9a2b-7c3d4e5f6a7b', name: 'Aqua Seal Systems' },
    lines: [
      { seq: 1, code: '2.1', description: 'Terrace', unit: 'sqm', qty: '100' },
      { seq: 2, code: '2.2', description: 'Toilets', unit: 'sqm', qty: '40' },
      { seq: 3, code: null, description: 'Extra for coving', unit: 'm', qty: null },
    ],
  });

async function edit(buffer: Buffer, fn: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  fn(wb.getWorksheet('Enquiry')!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('reading a filled enquiry', () => {
  it('leaves blank answers blank (the merged label cell is not read as an answer)', async () => {
    const filled = await edit(await pack(), (ws) => {
      ws.getCell('F16').value = 350;
      ws.getCell('F17').value = 200;
    });
    const q = await readQuoteWorkbook(filled);
    expect(q).toMatchObject({
      rfqId: '5d1c3c2e-9a51-4f0e-8a43-2f6d3f1c0a11',
      vendorId: '0b0e8d4f-6c1a-4f5e-9a2b-7c3d4e5f6a7b',
      reference: null,
      validUntil: null,
      gstMode: 'extra',
      gstPct: '18',
      skipped: 1,
      issues: [],
    });
    expect(q.lines).toEqual([
      { seq: 1, rate: '350', remark: '' },
      { seq: 2, rate: '200', remark: '' },
    ]);
  });

  it('reads rows copied into a fresh workbook, with rates as text and a totals row added', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRows([
      ['Your quote reference', '', 'DT/88'],
      ['GST', '', 'Included in the rates'],
      ['GST rate %', '', '12%'],
      [],
      ['S.No', 'Code', 'Description', 'Unit', 'Quantity', 'Rate (₹)', 'Amount (₹)', 'Remarks'],
      [1, '2.1', 'Terrace', 'sqm', 100, '1,234.50', null, 'With primer'],
      [2, '2.2', 'Toilets', 'sqm', 40, '', null, ''],
      ['Total', null, null, null, null, null, 123450],
      [3, null, 'Extra for coving', 'm', null, 45, null, ''],
    ]);
    const q = await readQuoteWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(q).toMatchObject({
      rfqId: null,
      vendorId: null,
      reference: 'DT/88',
      gstMode: 'included',
      gstPct: '12',
      skipped: 1,
      issues: [],
    });
    expect(q.lines).toEqual([
      { seq: 1, rate: '1234.5', remark: 'With primer' },
      { seq: 3, rate: '45', remark: '' },
    ]);
  });

  it('reports a rate that is not a number, and a date that is not a date', async () => {
    const filled = await edit(await pack(), (ws) => {
      ws.getCell('C11').value = 'till stock lasts';
      ws.getCell('F16').value = 'approx 300';
    });
    const q = await readQuoteWorkbook(filled);
    expect(q.issues).toEqual([
      '"Valid until" (till stock lasts) is not a date; it was left out.',
      'Line 1: rate "approx 300" is not a number.',
    ]);
    expect(q.lines).toEqual([]);
  });
});
