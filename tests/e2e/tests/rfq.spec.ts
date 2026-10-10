// Wave 1 step 9 in a real browser: an RFQ for the waterproofing items of a BOQ goes to two subcontractors. One fills
// in the Excel enquiry (imported back), the other's quote is typed in with GST included; the comparative statement
// compares them before GST, the choice is made per line, and the chosen rates go into the BOQ.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

const BOQ =
  'Code,Description,Unit,Qty,Rate\r\n' +
  '1,Waterproofing,,,\r\n' +
  '1.1,Waterproofing of terrace with APP membrane,sqm,100,340\r\n' +
  '1.2,Waterproofing of toilets with polymer coating,sqm,40,230\r\n' +
  '2,Plaster,,,\r\n' +
  '2.1,Internal plaster 12 mm in CM 1:6,sqm,500,210\r\n';

test('an estimator asks two subcontractors, compares their quotes and prices the BOQ from the choice', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `rfq-${Date.now()}@wankhede-constructions.in`,
    'Tie-Wire-Binding-Coil-41',
    'Wankhede Constructions',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Boys hostel, Yavatmal');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('BOQ file').setInputFiles({
    name: 'civil.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(BOQ),
  });
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('button', { name: 'Import 5 lines' }).click();
  await expect(page.getByTestId('boq-total')).toHaveText('₹1,48,200', { timeout: 30_000 });

  // 1. The RFQ, from the tender page: the Waterproofing section brings its two items.
  await page.getByRole('link', { name: /Boys hostel, Yavatmal/ }).click();
  await page
    .getByRole('tablist', { name: 'Tender sections' })
    .getByRole('tab', { name: 'RFQs' })
    .click();
  await page.getByRole('button', { name: 'New RFQ' }).click();
  await page.getByLabel('RFQ title').fill('Waterproofing package');
  await page.getByLabel('Terms').fill('Rates for complete work with 10-year guarantee.');
  await page.getByRole('button', { name: 'Create RFQ' }).click();
  await expect(page.getByRole('heading', { name: 'Waterproofing package' })).toBeVisible();
  const rfqUrl = page.url();
  await page.getByRole('button', { name: 'From the BOQ' }).click();
  await page
    .getByRole('list', { name: 'BOQ lines to ask for' })
    .getByRole('checkbox', { name: /Waterproofing/ })
    .check();
  await page.getByRole('button', { name: 'Add 1 to the RFQ' }).click();
  await expect(page.getByText('Added 2 lines.')).toBeVisible();

  // 2. Two subcontractors, new to the party master.
  for (const [name, email] of [
    ['Aqua Seal Systems', 'quotes@aquaseal.in'],
    ['DryTech Waterproofing', ''],
  ] as const) {
    await page.getByLabel('Subcontractor').fill(name);
    if (email) await page.getByLabel('Email (optional)').fill(email);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('listitem', { name })).toBeVisible();
  }

  // 3. Aqua Seal's enquiry goes out as Excel and comes back filled in.
  const aqua = page.getByRole('listitem', { name: 'Aqua Seal Systems' });
  const downloading = page.waitForEvent('download');
  await aqua.getByRole('button', { name: 'Download the enquiry for Aqua Seal Systems' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^RFQ_.*Aqua Seal Systems\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Enquiry')!;
  expect(ws.getCell('C16').value).toBe('Waterproofing of terrace with APP membrane');
  ws.getCell('C10').value = 'ASS/Q/118';
  ws.getCell('F16').value = 350;
  ws.getCell('F17').value = 200;
  ws.getCell('H17').value = 'Two coats';
  const filled = Buffer.from(await wb.xlsx.writeBuffer());
  await aqua.getByRole('button', { name: 'Mark sent' }).click();
  await expect(aqua.getByText(/^Sent/)).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await aqua.getByRole('button', { name: 'Import the quote of Aqua Seal Systems' }).click();
  await (
    await choosing
  ).setFiles({
    name: 'RFQ Aqua Seal Systems - filled.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: filled,
  });
  await expect(page.getByText('Imported 2 rates from Aqua Seal Systems.')).toBeVisible();
  await expect(aqua.getByText(/Quote ASS\/Q\/118, received/)).toBeVisible();

  // 4. DryTech quoted on paper, GST included: typed in.
  const dry = page.getByRole('listitem', { name: 'DryTech Waterproofing' });
  await dry.getByRole('button', { name: 'Type the quote of DryTech Waterproofing' }).click();
  const form = page.getByRole('form', { name: 'Quote of DryTech Waterproofing' });
  await form.getByLabel('GST', { exact: true }).selectOption('included');
  await form.getByLabel('Rate for line 1').fill('413');
  await form.getByLabel('Rate for line 2').fill('212.40');
  await form.getByRole('button', { name: /Save quote \(2 of 2 lines\)/ }).click();
  await expect(form).toBeHidden();

  // 5. Compared before GST: 413 incl. 18% is 350, a tie on line 1; 212.40 is 180, the lowest on line 2.
  const cs = page.getByRole('rowgroup', { name: 'Comparative statement' });
  await expect(cs.getByRole('row').nth(1)).toContainText('180.00');
  await expect(page.getByText('₹42,200').first()).toBeVisible(); // L1 split: 35,000 + 7,200
  await page.getByRole('button', { name: 'Choose the lowest on every line' }).click();
  await expect(page.getByLabel('Vendor for line 2')).toHaveValue(/.+/);
  await expect(page.getByLabel('Vendor for line 1')).toHaveValue(''); // a tie is the estimator's call
  await page.getByLabel('Vendor for line 1').selectOption({ label: 'Aqua Seal Systems' });
  await expect(page.getByText('Chosen (2 of 2 lines)')).toBeVisible();
  await page.screenshot(shot('rfq-01-comparative'));

  // 6. The chosen rates go into the BOQ as edits: 350 and 180 replace 340 and 230.
  await page.getByRole('button', { name: 'Put the chosen rates into the estimate' }).click();
  await expect(page.getByText('2 rates changed.')).toBeVisible();
  await page.getByRole('link', { name: 'Civil' }).click();
  await expect(page.getByTestId('boq-total')).toHaveText('₹1,47,200', { timeout: 30_000 });

  // 7. The tender's activity records the RFQ.
  await page.getByRole('link', { name: /Boys hostel, Yavatmal/ }).click();
  await expect(page.getByText(/Quote from DryTech Waterproofing on RFQ\//)).toBeVisible();
  await expect(page.getByText(/put into the estimate: 2 BOQ item\(s\)/)).toBeVisible();

  // 8. Negotiation: DryTech comes down to 340 on the terrace, now GST extra. Their first quote is kept as round 1.
  await page.goto(rfqUrl);
  await dry.getByRole('button', { name: 'Type the quote of DryTech Waterproofing' }).click();
  await expect(form.getByRole('radio', { name: /A revised quote: keep round 1/ })).toBeChecked();
  await form.getByLabel('GST', { exact: true }).selectOption('extra');
  await form.getByLabel('Rate for line 1').fill('340');
  await form.getByLabel('Rate for line 2').fill('180');
  await form.getByRole('button', { name: /Save quote \(2 of 2 lines\)/ }).click();
  await expect(form).toBeHidden();
  await expect(dry.getByText('Round 2', { exact: true })).toBeVisible();
  const rounds = page.getByRole('region', { name: 'Rounds of DryTech Waterproofing' });
  await expect(rounds.getByTestId('round-total')).toHaveText(['42,200.00', '41,200.00']);
  await expect(rounds.getByRole('row').nth(1)).toContainText('-2.9 %');

  // 9. Aqua Seal's covering letter is kept with their quote (and in the tender's documents).
  const attaching = page.waitForEvent('filechooser');
  await aqua.getByRole('button', { name: 'Attach documents of Aqua Seal Systems' }).click();
  await (
    await attaching
  ).setFiles({
    name: 'Aqua Seal covering letter.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 covering letter'),
  });
  await expect(
    page.getByText('Attached Aqua Seal covering letter.pdf, kept in the tender documents.'),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Documents of Aqua Seal Systems' })).toContainText(
    'Aqua Seal covering letter.pdf',
  );
  await page.screenshot(shot('rfq-02-negotiation'));
});
