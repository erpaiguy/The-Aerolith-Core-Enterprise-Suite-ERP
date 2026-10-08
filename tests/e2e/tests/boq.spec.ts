// Wave 1 step 3 in a real browser: building and editing a BOQ in the grid with the keyboard, totals, formulas,
// undo, paste from a spreadsheet, scrolling windows, collapse, outline and search jumps, outdent, and persistence.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const row = (page: Page, text: string) => grid(page).getByRole('row').filter({ hasText: text });
const cell = (page: Page, text: string, col: string) =>
  row(page, text).locator(`[data-col="${col}"]`);

test('an estimator builds and edits a BOQ in the grid', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `qs-${Date.now()}@deshmukh-constructions.in`,
    'Plaster-Of-Paris-61',
    'Deshmukh Constructions',
  );

  // A tender with an empty BOQ.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Primary health centre, Satara');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil works');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Civil works' })).toBeVisible();
  await expect(page.getByText('Empty BOQ.')).toBeVisible();

  // 1. A section and two items, typed with the keyboard. Tab moves right; typing starts editing.
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter'); // first item inside the open section
  await page.getByLabel('Edit description').fill('Excavation in ordinary soil');
  await page.keyboard.press('Tab');
  await page.keyboard.type('cum');
  await page.keyboard.press('Tab');
  await page.keyboard.type('120.5');
  await page.keyboard.press('Tab');
  await page.keyboard.type('350');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('42,175.00');
  await expect(page.getByTestId('boq-total')).toHaveText('₹42,175');

  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Backfilling');
  await page.keyboard.press('Tab');
  await page.keyboard.type('cum');
  await page.keyboard.press('Tab');
  await page.keyboard.type('=40*2'); // formulas are evaluated, the value is stored
  await page.keyboard.press('Tab');
  await page.keyboard.type('210.25');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Backfilling', 'qty')).toHaveText('80');
  await expect(cell(page, 'Backfilling', 'amount')).toHaveText('16,820.00');
  await expect(row(page, 'Earthwork').getByTestId(/^subtotal-/)).toHaveText('58,995.00');
  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.screenshot(shot('boq-01-typed'));

  // 2. A bad value is explained and not saved; Escape abandons it.
  await cell(page, 'Backfilling', 'qty').click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a number.' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cell(page, 'Backfilling', 'qty')).toHaveText('80');

  // 3. Undo the last edit (the rate): the amount and every total follow.
  await grid(page).press('Control+z');
  await expect(cell(page, 'Backfilling', 'amount')).toHaveText('');
  await expect(page.getByTestId('boq-total')).toHaveText('₹42,175');

  // 4. Paste 300 lines copied from a spreadsheet, starting at the code column.
  await cell(page, 'Backfilling', 'code').click();
  const tsv = Array.from(
    { length: 300 },
    (_, i) => `P.${i + 1}\tPasted line ${i + 1}\tsqm\t1\t10`,
  ).join('\n');
  await grid(page).evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, tsv);
  await expect(page.getByText('Pasted 300 lines.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('boq-total')).toHaveText('₹45,175');
  await expect(page.getByText('302 items · 303 lines')).toBeVisible();

  // 5. Jump to the end and back: windows load as needed.
  await grid(page).press('Control+End');
  await expect(row(page, 'Pasted line 300')).toBeVisible();
  await grid(page).press('Control+Home');
  await expect(row(page, 'Excavation')).toBeVisible();

  // 6. Collapse the section: its lines disappear; expand brings them back.
  await row(page, 'Earthwork').getByRole('button', { name: 'Collapse section' }).click();
  await expect(row(page, 'Excavation')).toHaveCount(0);
  await row(page, 'Earthwork').getByRole('button', { name: 'Expand section' }).click();
  await expect(row(page, 'Excavation')).toBeVisible();

  // 7. Search and jump to a line far down.
  await page.getByLabel('Search this BOQ').fill('line 250');
  await page
    .getByRole('navigation', { name: 'Search results' })
    .getByRole('button', { name: /Pasted line 250/ })
    .click();
  await expect(row(page, 'Pasted line 250')).toBeVisible();
  await page.getByLabel('Clear search').click();

  // 8. Outdent the last line out of the section: the section subtotal drops, the BOQ total does not.
  await grid(page).press('Control+End');
  await cell(page, 'Pasted line 300', 'description').click();
  await grid(page).press('Alt+Shift+ArrowLeft');
  await expect(row(page, 'Pasted line 300')).toHaveAttribute('aria-level', '1');
  await page.getByRole('button', { name: /Earthwork/ }).click(); // outline jump
  await expect(row(page, 'Earthwork').getByTestId(/^subtotal-/)).toHaveText('45,165.00');
  await expect(page.getByTestId('boq-total')).toHaveText('₹45,175');
  await page.screenshot(shot('boq-02-edited'));

  // 9. Everything is saved: a reload shows the same BOQ.
  await page.reload();
  await expect(page.getByTestId('boq-total')).toHaveText('₹45,175');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('42,175.00');
});

test('scrolling a 3,000-line BOQ keeps every line in order while the window slides', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `big-${Date.now()}@patil-infra.in`,
    'Rebar-Couplers-Twenty-2',
    'Patil Infra',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Township roads, phase 2');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Roads');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Empty BOQ.')).toBeVisible();

  // 3,000 lines in one paste (saved as six batches of 500).
  await grid(page).click();
  const tsv = Array.from(
    { length: 3000 },
    (_, i) => `L${String(i + 1).padStart(4, '0')}\tRoad line ${i + 1}\tm\t1\t1`,
  ).join('\n');
  await grid(page).evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, tsv);
  await expect(page.getByText('Pasted 3000 lines.')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('boq-total')).toHaveText('₹3,000');

  /** Codes of the rows currently rendered, top to bottom. */
  const renderedCodes = () =>
    grid(page).evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('[role="row"][data-row-id]')]
        .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
        .map((r) => Number(r.querySelector('[data-col="code"]')!.textContent!.slice(1))),
    );
  const contiguous = (codes: number[]) => codes.every((c, i) => i === 0 || c === codes[i - 1]! + 1);

  await grid(page).press('Control+Home');
  await expect(grid(page).getByRole('row', { name: /^L0001 Road line 1 / })).toBeVisible();
  // Scroll down in steps of ~90 rows: windows load ahead, and early rows are dropped past 2,400.
  let lastTop = 0;
  for (let step = 0; step < 60; step++) {
    await grid(page).evaluate((el) => el.scrollBy(0, 2900));
    await page.waitForTimeout(120);
    const codes = await renderedCodes();
    expect(contiguous(codes), `step ${step}: ${codes.join(',')}`).toBe(true);
    expect(codes[0]!).toBeGreaterThanOrEqual(lastTop);
    lastTop = codes[0]!;
    if (codes.includes(3000)) break;
  }
  await expect(grid(page).getByRole('row', { name: /^L3000 Road line 3000 / })).toBeVisible();
  // And back up to the top: windows load before, and the far end is dropped.
  for (let step = 0; step < 60; step++) {
    await grid(page).evaluate((el) => el.scrollBy(0, -2900));
    await page.waitForTimeout(120);
    const codes = await renderedCodes();
    expect(contiguous(codes), `up ${step}: ${codes.join(',')}`).toBe(true);
    if (codes.includes(1)) break;
  }
  await expect(grid(page).getByRole('row', { name: /^L0001 Road line 1 / })).toBeVisible();
});
