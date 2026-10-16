// Wave 5 steps 4 and 5 in a real browser: the project's revision series refusing a skipped label, the matrix sending
// the construction revision to the lead to acknowledge, a controlled copy and its check page signed out; a signature
// drawn with the mouse and saved, a field dragged on the PDF, the document signed, verified and downloaded.
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

/** Drags from one point to another inside an element, as fractions of its size. */
async function drag(
  page: Page,
  el: ReturnType<Page['getByRole']>,
  from: [number, number],
  to: [number, number],
) {
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 8 });
  await page.mouse.up();
}

test('a controlled revision checked signed out, and a drawing signed with a drawn signature', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const email = `signoff-${Date.now()}@washim-build.in`;
  await signInNewAdmin(page, email, 'Drawn-Signature-Washim-27', 'Washim Build');
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Market yard, Washim');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByRole('main').getByRole('link', { name: 'Documents and drawings' }).click();
  await page.waitForURL(/\/documents$/);

  // Revision control: numbers after P; the admin (the lead) on the matrix for every discipline.
  await page.getByRole('tab', { name: 'Revision control' }).click();
  await page.getByLabel('Series').selectOption('numbers');
  await expect(page.getByLabel('Series')).toHaveValue('numbers');
  const m = page.getByRole('form', { name: 'Add to the matrix' });
  await m.getByLabel('Who').selectOption({ index: 1 });
  await m.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('list', { name: 'Distribution' })).toContainText(
    'inside, acknowledges receipt',
  );

  // The register: P2 first is refused; P1, then 0 for construction.
  await page.getByRole('tab', { name: 'Drawings register' }).click();
  await page.getByRole('button', { name: 'Add a drawing' }).click();
  await page.getByLabel('Drawing number').fill('A-301');
  await page.getByLabel('Title').fill('Shop elevations');
  await page.getByRole('button', { name: 'Add drawing', exact: true }).click();
  const revise = async (rev: string, purpose: string, text: string) => {
    await page.getByLabel('Revision', { exact: true }).fill(rev);
    await page.getByLabel('Purpose').selectOption({ label: purpose });
    await page.getByLabel('Drawing file').setInputFiles([file(`A-301 ${rev}.pdf`, text)]);
    await page.getByRole('button', { name: 'Add revision' }).click();
  };
  await revise('P2', 'For approval', 'Elevations P2');
  await expect(page.getByText('The next revision is P1 or 0, not P2.')).toBeVisible();
  await revise('P1', 'For approval', 'Elevations P1');
  await expect(page.getByTestId('next-revision')).toContainText('P2 or 0');
  await revise('0', 'Good for construction', 'Elevations rev 0');
  const rows = page.getByRole('rowgroup', { name: 'Revisions' }).getByRole('row');
  await expect(rows.nth(0)).toContainText('0 of 1');

  // A controlled copy, and its check page in a browser that never signed in.
  const copy = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Controlled copy of revision 0' }).click();
  expect((await copy).suggestedFilename()).toBe('A-301 rev 0 controlled copy.pdf');
  const checkP1 = await rows.nth(1).getByRole('link', { name: 'Check page' }).getAttribute('href');
  const outside = await browser.newContext();
  const them = await outside.newPage();
  await them.goto(new URL(checkP1!, page.url()).toString());
  await expect(them.getByTestId('check-result')).toContainText('Superseded on');
  await expect(them.getByTestId('check-result')).toContainText('the current revision is 0');
  await outside.close();

  // The lead acknowledges the new revision.
  await nav('Drawing receipts');
  await page
    .getByRole('row', { name: 'A-301 rev 0' })
    .getByRole('button', { name: 'Acknowledge' })
    .click();
  await expect(page.getByRole('row', { name: 'A-301 rev 0' })).toContainText('Acknowledged');

  // A signature drawn and saved; a sign-off of the construction revision; signed, verified, downloaded.
  await nav('Sign-offs');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await drag(
    page,
    page.getByRole('img', { name: 'Signature pad' }).or(page.getByLabel('Signature pad')).first(),
    [0.1, 0.6],
    [0.8, 0.4],
  );
  await page.getByRole('button', { name: 'Save my signature' }).click();
  await expect(page.getByRole('img', { name: 'My saved signature' })).toBeVisible();
  await page.getByLabel('Title').fill('A-301 for construction');
  await page.getByLabel('Document (PDF)').selectOption({ index: 1 });
  await page.getByLabel('Add a signer').selectOption({ index: 1 });
  const page1 = page.getByRole('application', { name: 'Page 1' });
  await expect(page1).toBeVisible();
  await page1.scrollIntoViewIfNeeded();
  await drag(page, page1, [0.6, 0.08], [0.9, 0.2]);
  await expect(page.getByRole('list', { name: 'Signers in order' })).toContainText(
    'field on page 1',
  );
  await page.getByRole('button', { name: 'Start the sign-off' }).click();
  await expect(page.getByTestId('signoff-status')).toContainText('open');
  await page.getByRole('button', { name: 'Sign with my saved signature' }).click();
  await expect(page.getByTestId('signoff-status')).toContainText('signed as version 3');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByTestId('signoff-verified')).toContainText('Intact');
  const signed = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the signed copy' }).click();
  expect((await signed).suggestedFilename()).toMatch(/A-301/);
  await shot(page, 'sign-off');
});
