// Wave 1 step 10 in a real browser: a tender's documents. The standard folders, drawings uploaded and one replaced
// by its next revision, a folder of qualification papers uploaded with its sub-folders, a preview, tags, the trash,
// a ZIP of a folder, and the search across tenders.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

/** A small, valid one-page PDF with a line of text. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const file = (name: string, text: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: pdf(text),
});
const folders = (page: Page) => page.getByRole('navigation', { name: 'Document folders' });
const documents = (page: Page) => page.getByRole('rowgroup', { name: 'Documents' });
const uploads = (page: Page) => page.getByRole('region', { name: 'Uploads' });

test('an estimator keeps the tender documents: folders, versions, preview, trash, ZIP and search', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `docs-${Date.now()}@bhosale-buildcon.in`,
    'Plumb-Bob-Level-Mark-27',
    'Bhosale Buildcon',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Sub-district hospital, Malkapur');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page
    .getByRole('tablist', { name: 'Tender sections' })
    .getByRole('tab', { name: 'Documents' })
    .click();

  // 1. The standard folders; the commercial ones are restricted.
  await page.getByRole('button', { name: 'Add the standard folders' }).click();
  await expect(folders(page).getByRole('button', { name: /06 Our financial bid/ })).toContainText(
    '06 Our financial bid',
  );
  await expect(
    folders(page)
      .getByRole('button', { name: /06 Our financial bid/ })
      .getByLabel('restricted'),
  ).toBeVisible();

  // 2. Drawings uploaded; the GA plan's next revision under the same name becomes version 2.
  await folders(page)
    .getByRole('button', { name: /02 Drawings/ })
    .click();
  await page
    .getByLabel('Files to upload')
    .setInputFiles([file('GA plan.pdf', 'GA plan rev A'), file('Sections.pdf', 'Sections')]);
  await expect(uploads(page)).toContainText('Uploaded 2 of 2');
  await expect(documents(page).getByRole('button', { name: 'GA plan.pdf' })).toBeVisible();
  await page.getByLabel('Files to upload').setInputFiles([file('GA plan.pdf', 'GA plan rev B')]);
  await expect(uploads(page)).toContainText('New version (v2)');
  await expect(documents(page).getByRole('row', { name: /GA plan\.pdf/ })).toContainText('v2');

  // 3. A folder of qualification papers, with its sub-folder, into the technical bid.
  const dir = await mkdtemp(join(tmpdir(), 'aerolith-upload-'));
  await mkdir(join(dir, 'Qualification', 'Financial'), { recursive: true });
  await writeFile(join(dir, 'Qualification', 'Work orders.pdf'), pdf('Work orders'));
  await writeFile(join(dir, 'Qualification', 'Financial', 'Turnover certificate.pdf'), pdf('CA'));
  await folders(page)
    .getByRole('button', { name: /05 Our technical bid/ })
    .click();
  await page.getByLabel('Folder to upload').setInputFiles(join(dir, 'Qualification'));
  await expect(uploads(page)).toContainText('Uploaded 2 of 2');
  await folders(page)
    .getByRole('button', { name: /^Financial/ })
    .click();
  await expect(
    documents(page).getByRole('button', { name: 'Turnover certificate.pdf' }),
  ).toBeVisible();

  // 4. The GA plan: preview, both versions, tags.
  await folders(page)
    .getByRole('button', { name: /02 Drawings/ })
    .click();
  await documents(page).getByRole('button', { name: 'GA plan.pdf' }).click();
  const panel = page.getByRole('region', { name: 'Document GA plan.pdf' });
  await expect(panel.locator('iframe[title="Preview"]')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Versions' }).getByRole('listitem')).toHaveCount(2);
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download version 1' }).click();
  expect((await downloading).suggestedFilename()).toBe('GA plan (v1).pdf');
  await panel.getByRole('button', { name: 'Edit details' }).click();
  await panel.getByLabel('Tags').fill('Architectural, Rev B');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(documents(page).getByRole('row', { name: /GA plan\.pdf/ })).toContainText(
    'Architectural',
  );
  await page.screenshot(shot('documents-01-vault'));

  // 5. Sections to the trash and back.
  await documents(page).getByRole('button', { name: 'Sections.pdf' }).click();
  await page
    .getByRole('region', { name: 'Document Sections.pdf' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(documents(page).getByRole('button', { name: 'Sections.pdf' })).toBeHidden();
  await page.getByRole('button', { name: 'Trash (1)' }).click();
  await page.getByRole('list', { name: 'Trash' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('button', { name: 'Trash (0)' })).toBeVisible();

  // 6. The drawings folder as a ZIP.
  await folders(page)
    .getByRole('button', { name: /02 Drawings/ })
    .click();
  await expect(documents(page).getByRole('button', { name: 'Sections.pdf' })).toBeVisible();
  const zipping = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download folder (ZIP)' }).click();
  expect((await zipping).suggestedFilename()).toMatch(/^TND_.*02 Drawings\.zip$/);

  // 7. Found from the Documents page by tag.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Documents' })
    .click();
  await page.getByLabel('Search documents').fill('architectural');
  const results = page.getByRole('rowgroup', { name: 'Search results' });
  await expect(results.getByRole('row')).toHaveCount(1);
  await expect(results).toContainText('GA plan.pdf');
  await expect(
    results.getByRole('link', { name: 'Sub-district hospital, Malkapur' }),
  ).toBeVisible();
});
