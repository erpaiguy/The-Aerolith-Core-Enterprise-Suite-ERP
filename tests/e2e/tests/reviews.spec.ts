// Wave 5 step 1 in a real browser: a project's review workflow; a drawing sent for review, returned with code C,
// revised, resubmitted and approved.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

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

test('a drawing reviewed, returned, revised and approved', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `review-${Date.now()}@jalna-build.in`,
    'Review-Stage-Codes-51',
    'Jalna Build',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Library, Jalna');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();

  // The drawing in the project's vault.
  const upload = async (text: string, expectText: string) => {
    await page.goto(`${projectUrl}/documents`);
    await page.getByRole('tab', { name: 'All documents' }).click();
    await page.getByLabel('Files to upload').setInputFiles([file('S-201 Footings.pdf', text)]);
    await expect(page.getByRole('region', { name: 'Uploads' })).toContainText(expectText);
  };
  await upload('Footings rev 0', 'Uploaded 1 of 1');

  // A one-stage workflow: the project lead (the admin, who made the project) checks.
  await nav('Reviews');
  await page.getByLabel('Project').selectOption({ index: 1 });
  const wf = page.getByRole('form', { name: 'New workflow' });
  await wf.getByLabel('Workflow name').fill('Structural check');
  const stage = wf.getByRole('group', { name: 'Stage 1' });
  await stage.getByLabel('Stage name').fill('Structural engineer');
  await stage.getByLabel('Add reviewer').selectOption('lead');
  await wf.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByTestId('review-workflows')).toContainText('Structural check');

  const start = page.getByRole('form', { name: 'Start a review' });
  await start.getByLabel('Document').selectOption({ label: 'S-201 Footings.pdf (rev 1)' });
  await start.getByLabel('Workflow').selectOption({ label: 'Structural check' });
  await start.getByLabel('Title').fill('Footing layout for block A');
  await start.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByTestId('review-status')).toContainText('in review');
  await expect(page.getByTestId('reviews-mine')).toContainText('RV-001 Footing layout for block A');

  // Code C: returned for revision.
  const respond = async (code: string, comment: string) => {
    const f = page.getByRole('form', { name: 'Respond' });
    await f.getByLabel('Code').selectOption(code);
    await f.getByLabel('Comment').fill(comment);
    await f.getByRole('button', { name: 'Respond' }).click();
  };
  await respond('C', 'Footing F3 under-sized for the column load');
  await expect(page.getByTestId('review-status')).toContainText('returned');
  await expect(page.getByRole('row', { name: 'RV-001' })).toContainText('returned');

  // Revised, resubmitted, approved with code A.
  await upload('Footings rev 1', 'New version (v2)');
  await nav('Reviews');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByRole('row', { name: 'RV-001' }).getByRole('button', { name: 'RV-001' }).click();
  await page.getByRole('button', { name: 'Resubmit the latest revision' }).click();
  await expect(page.getByRole('row', { name: 'RV-002' })).toContainText('rev 2');
  await page.getByRole('row', { name: 'RV-002' }).getByRole('button', { name: 'RV-002' }).click();
  await respond('A', 'F3 enlarged; good');
  await expect(page.getByTestId('review-status')).toContainText('approved');
  await expect(page.getByText('Nothing waiting on you.')).toBeVisible();
  await shot(page, 'reviews');
});
