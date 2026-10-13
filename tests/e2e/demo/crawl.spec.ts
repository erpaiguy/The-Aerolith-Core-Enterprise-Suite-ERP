// Opens every screen each demo person can reach (the side menu, plus the detail pages of the seeded records) and
// fails on anything broken: an uncaught error in the page, a request the server answered with 4xx or 5xx, or a red
// error banner. Reads the seeded sign-ins with load.ts.
import { appendFileSync } from 'node:fs';
import { loadDemo } from './load.js';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { timeStep, totp } from '../tests/helpers.js';

const demo = loadDemo();

interface Problem {
  who: string;
  path: string;
  what: string;
}
const problems: Problem[] = [];
const REPORT = process.env.DEMO_REPORT ?? 'demo-problems.jsonl';
const record = (p: Problem) => {
  problems.push(p);
  appendFileSync(REPORT, `${JSON.stringify(p)}\n`);
};
const inflight = new WeakMap<Page, number>();

function watch(page: Page, who: string, where: () => string) {
  inflight.set(page, 0);
  const api = (u: string) => new URL(u).pathname.startsWith('/api/');
  page.on('request', (r) => api(r.url()) && inflight.set(page, (inflight.get(page) ?? 0) + 1));
  for (const ev of ['requestfinished', 'requestfailed'] as const)
    page.on(
      ev,
      (r) => api(r.url()) && inflight.set(page, Math.max(0, (inflight.get(page) ?? 1) - 1)),
    );
  page.on('pageerror', (e) => record({ who, path: where(), what: `page error: ${e.message}` }));
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith('/api/') || r.status() < 400) return;
    // A refresh with no session yet is how the app learns it is signed out.
    if (url.pathname.endsWith('/auth/refresh') && r.status() < 500) return;
    record({
      who,
      path: where(),
      what: `${r.request().method()} ${url.pathname} -> ${r.status()}`,
    });
  });
}

/** Until no API request has been open for half a second (screens that poll never go fully idle), at most 10 s. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  let quiet = 0;
  for (let t = 0; t < 10_000 && quiet < 500; t += 100) {
    await page.waitForTimeout(100);
    quiet = (inflight.get(page) ?? 0) === 0 ? quiet + 100 : 0;
  }
}

async function banners(page: Page, who: string, path: string) {
  for (const text of await page.getByRole('alert').allInnerTexts())
    if (text.trim()) record({ who, path, what: `error banner: ${text.trim().slice(0, 200)}` });
}

async function signIn(
  browser: Browser,
  who: string,
  username: string,
  password: string,
  secret?: string,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let current = '/';
  watch(page, who, () => current);
  await page.goto('/');
  await page.getByLabel('Licence key').fill(demo.licenceKey);
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByLabel('Username or admin email').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (secret) {
    // A fresh window, in case the seeder's sign-in used this one (a code is accepted once).
    const step = timeStep();
    while (timeStep() === step) await page.waitForTimeout(1000);
    await page.getByLabel('Authenticator code').fill(totp(secret, timeStep()));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await page.getByRole('link', { name: 'Home' }).waitFor({ timeout: 30_000 });
  return { page, context, at: (p: string) => (current = p) };
}

async function crawl(
  browser: Browser,
  who: string,
  username: string,
  password: string,
  secret?: string,
) {
  const { page, context, at } = await signIn(browser, who, username, password, secret);
  const nav = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
  const paths = [...new Set([...nav, ...demo.paths])].filter((p) => p.startsWith('/'));
  for (const path of paths) {
    at(path);
    // In-app navigation, as a person clicking around: a full reload per screen would re-check the licence each time
    // and soon meet the rate limit, which no person would.
    await page.evaluate((p) => {
      window.history.pushState({}, '', p);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page
      .waitForURL((u) => u.pathname === path.split('?')[0], { timeout: 5_000 })
      .catch(() => record({ who, path, what: 'did not navigate' }));
    await settle(page);
    await banners(page, who, path);
    if (await page.getByText('Something went wrong').count())
      record({ who, path, what: 'error boundary shown' });
  }
  await context.close();
  return paths.length;
}

test('the admin opens every screen cleanly', async ({ browser }) => {
  const before = problems.length;
  const n = await crawl(browser, 'admin', demo.admin.email, demo.admin.password, demo.admin.secret);
  console.log(`admin: ${n} screens`);
  expect(problems.slice(before)).toEqual([]);
});

for (const u of demo.staff)
  test(`${u.username} (${u.role}) opens every screen cleanly`, async ({ browser }) => {
    const before = problems.length;
    const n = await crawl(browser, u.username, u.username, u.password);
    console.log(`${u.username}: ${n} screens`);
    expect(problems.slice(before)).toEqual([]);
  });

for (const u of demo.portal)
  test(`portal ${u.kind} opens every tab cleanly`, async ({ browser }) => {
    const before = problems.length;
    const context = await browser.newContext();
    const page = await context.newPage();
    let current = `/portal/${demo.tenantId}`;
    watch(page, u.email, () => current);
    await page.goto(current);
    await page.getByLabel('Email').fill(u.email);
    await page.getByLabel('Password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('tablist').waitFor();
    for (const tab of await page.getByRole('tab').allInnerTexts()) {
      current = `portal ${u.kind}: ${tab}`;
      await page.getByRole('tab', { name: tab }).click();
      await settle(page);
      const first = page.locator('main button.underline').first();
      if (await first.count()) {
        await first.click();
        await settle(page);
      }
      await banners(page, u.email, current);
    }
    await context.close();
    expect(problems.slice(before)).toEqual([]);
  });
