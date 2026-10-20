// Accessibility (docs/wave9-plan.md step 9a.8): axe checks the main screens against WCAG 2.1 A and AA and fails on
// anything serious or critical (the rest is listed on the test as annotations); and from the top of a page the
// keyboard reaches "Skip to content" first, that link moves focus to the page, and the menu, search and header
// buttons are all reachable with a visible focus ring.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.use({ viewport: { width: 1280, height: 800 } });
test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The screens checked once signed in, by address. */
const SCREENS: { name: string; path: string }[] = [
  { name: 'home', path: '/' },
  { name: 'tenders', path: '/tenders' },
  { name: 'new tender', path: '/tenders/new' },
  { name: 'projects', path: '/projects' },
  { name: 'orders', path: '/orders' },
  { name: 'requisitions', path: '/requisitions' },
  { name: 'stores', path: '/stores' },
  { name: 'receivables', path: '/accounts/receivables' },
  { name: 'payables', path: '/accounts/payables' },
  { name: 'vouchers', path: '/accounts/vouchers' },
  { name: 'documents', path: '/documents' },
  { name: 'settings', path: '/settings' },
  { name: 'users', path: '/users' },
  { name: 'approvals', path: '/approvals' },
  { name: 'legal page', path: '/legal/privacy-policy' },
];

/** Waits for the page to settle: its heading is there and nothing is loading. */
async function settle(page: Page) {
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

/** Runs axe; serious and critical problems are returned, the rest noted on the test. */
async function audit(page: Page, name: string, info: TestInfo): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const lines = (impacts: (string | null | undefined)[]) =>
    result.violations
      .filter((v) => impacts.includes(v.impact))
      .map(
        (v) =>
          `${name}: ${v.id} (${v.impact}) ${v.help} at ${v.nodes
            .slice(0, 5)
            .map((n) => n.target.join(' '))
            .join(', ')}`,
      );
  for (const description of lines(['minor', 'moderate', null, undefined]))
    info.annotations.push({ type: 'a11y', description });
  return lines(['serious', 'critical']);
}

test('the main screens have no serious accessibility problems', async ({ page }, info) => {
  // Sixteen screens, each loaded and audited: more than the default two minutes.
  test.setTimeout(360_000);
  await signInNewAdmin(
    page,
    `a11y-${Date.now()}@akola-infra.in`,
    'Every-Label-Akola-31',
    'Akola Infra Works',
  );
  const problems: string[] = [];
  for (const s of SCREENS) {
    await page.goto(s.path);
    await settle(page);
    problems.push(...(await audit(page, s.name, info)));
  }

  // Signed out: the sign-in screen.
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  // Not 'networkidle': a request cut short by signing out can stay open, and the screen is already drawn.
  await page.waitForTimeout(1_000);
  problems.push(...(await audit(page, 'sign-in', info)));

  expect(problems, problems.join('\n')).toEqual([]);
});

/** What has the keyboard now, and whether it shows a focus ring. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    const ring =
      el.matches(':focus-visible') &&
      ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none');
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' '),
      inMainMenu: !!el.closest('nav[aria-label="Main"]'),
      inHeader: !!el.closest('header'),
      ring,
    };
  });

test('the keyboard reaches everything from the top, with a visible focus ring', async ({
  page,
}) => {
  await signInNewAdmin(
    page,
    `keys-${Date.now()}@amravati-roads.in`,
    'Tab-Through-Amravati-44',
    'Amravati Roads',
  );
  await page.goto('/tenders');
  await settle(page);

  // From the top, the first stop is the skip link, and Enter moves the keyboard to the page itself.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  expect((await focused(page))?.ring).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  // The next stop is inside the page, not back in the menu.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true);

  // From the top again, Tab through the menu and the header.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const wanted = ['Search', 'New', 'Settings', 'Sign out'];
  const seen = new Set<string>();
  let menuLinks = 0;
  for (let i = 0; i < 400 && !wanted.every((w) => seen.has(w)); i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (!f) continue;
    expect(f.ring, `no focus ring on ${f.tag} "${f.name}"`).toBe(true);
    if (f.inMainMenu && f.tag === 'a') menuLinks++;
    if (f.inHeader) for (const w of wanted) if (f.name.startsWith(w)) seen.add(w);
    if (f.inHeader && f.tag === 'select') seen.add('Language');
  }
  expect(menuLinks).toBeGreaterThan(2);
  expect([...seen].sort()).toEqual([...wanted, 'Language'].sort());

  // The "New" menu opens from the keyboard and Esc puts the keyboard back on its button.
  const newButton = page.getByRole('banner').getByRole('button', { name: 'New' });
  await newButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Create' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'Create' })).toBeHidden();
  await expect(newButton).toBeFocused();
});
