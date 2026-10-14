// Wave 5 step 3 in a real browser: drawings issued on a transmittal for review, the link opened by the recipient in a
// signed-out browser, acknowledged and answered with a code; the register shows the answer. An RFI raised and answered.
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

test('a transmittal answered through its link, and an RFI answered', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `transmit-${Date.now()}@nanded-infra.in`,
    'Transmittal-Link-Nanded-38',
    'Nanded Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Court building, Nanded');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/documents`);
  await page.getByRole('tab', { name: 'All documents' }).click();
  await page
    .getByLabel('Files to upload')
    .setInputFiles([file('A-101 Plan.pdf', 'Plan'), file('A-201 Elevation.pdf', 'Elevation')]);
  await expect(page.getByRole('region', { name: 'Uploads' })).toContainText('Uploaded 2 of 2');

  // Drafted, issued, and a link made.
  await nav('Transmittals and RFIs');
  await page.getByLabel('Project').selectOption({ index: 1 });
  const f = page.getByRole('form', { name: 'New transmittal' });
  await f.getByLabel('Subject').fill('Architectural drawings for approval');
  await f.getByLabel('Recipient').fill('Kale Architects');
  await f
    .getByLabel('Documents')
    .selectOption([{ label: 'A-101 Plan.pdf (rev 1)' }, { label: 'A-201 Elevation.pdf (rev 1)' }]);
  await f.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('transmittal-status')).toContainText('draft');
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await expect(page.getByTestId('transmittal-status')).toContainText('issued');
  // Its cover sheet, printed (docs/wave7-plan.md step 7b.4); back, the project and transmittal are chosen again.
  await page.getByRole('link', { name: 'Print', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Transmittal' })).toContainText('Kale Architects');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByRole('row', { name: 'TR-001' }).getByRole('button', { name: 'TR-001' }).click();
  await page.getByRole('button', { name: 'Make a link for the recipient' }).click();
  const link = await page.getByLabel('Link for the recipient').inputValue();
  expect(link).toMatch(/\/share\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{43}$/);

  // The recipient: a browser that has never signed in.
  const outside = await browser.newContext();
  const them = await outside.newPage();
  await them.goto(link);
  await expect(them.getByTestId('share-head')).toContainText('Court building, Nanded');
  await expect(them.getByRole('button', { name: 'A-101 Plan.pdf' })).toBeVisible();
  const dl = them.waitForEvent('download');
  await them.getByRole('button', { name: 'A-201 Elevation.pdf' }).click();
  expect((await dl).suggestedFilename()).toContain('A-201 Elevation');
  await them.getByLabel('Your name').fill('Anita Kale');
  await them.getByRole('button', { name: 'Acknowledge receipt' }).click();
  await expect(them.getByTestId('share-acknowledged')).toContainText('Anita Kale');
  const r = them.getByRole('form', { name: 'Respond' });
  await r.getByLabel('Code').selectOption('B');
  await r.getByLabel('Response').fill('Approved; show the ramp on A-101');
  await r
    .getByLabel('Attach a file (optional)')
    .setInputFiles([file('Kale comments.pdf', 'Ramp please')]);
  await r.getByRole('button', { name: 'Send the response' }).click();
  await expect(them.getByTestId('share-responded')).toContainText('with code B');
  await them.screenshot({ path: 'screenshots/transmittal-share.png', fullPage: true });
  await outside.close();

  // Back inside: the register shows the answer and the file.
  await page.reload();
  await page.getByLabel('Project').selectOption({ index: 1 });
  await expect(page.getByRole('row', { name: 'TR-001' })).toContainText('responded B');
  await page.getByRole('row', { name: 'TR-001' }).getByRole('button', { name: 'TR-001' }).click();
  await expect(page.getByTestId('transmittal-response')).toContainText(
    'Answer from Anita Kale (B): Approved; show the ramp on A-101 · file Kale comments.pdf',
  );
  await shot(page, 'transmittals');

  // An RFI to the admin (the project's lead), answered and closed.
  await page.getByRole('tab', { name: 'RFIs' }).click();
  const q = page.getByRole('form', { name: 'New RFI' });
  await q.getByLabel('Subject').fill('Ramp gradient');
  await q.getByLabel('Assigned to').selectOption({ index: 1 });
  await q.getByLabel('Question').fill('Is the ramp 1 in 12 or 1 in 15?');
  await q.getByLabel('Location').fill('Main entrance');
  await q.getByRole('button', { name: 'Raise RFI' }).click();
  const rfi = page.getByRole('listitem', { name: 'RFI-001' });
  await expect(rfi).toContainText('open');
  await rfi.getByLabel('Answer, RFI-001').fill('1 in 12, as A-101');
  await rfi.getByRole('button', { name: 'Answer' }).click();
  await expect(rfi).toContainText('answered');
  await rfi.getByRole('button', { name: 'Close RFI' }).click();
  await expect(rfi).toContainText('closed');
});
