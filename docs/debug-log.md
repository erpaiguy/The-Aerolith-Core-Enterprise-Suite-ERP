# Debug pass after Wave 8

Every check run on the branch after Wave 8, what each found, and what was done about it. Status: **Fixed** (code
changed, with the commit), **Accepted** (left as is, with the reason), **Owner** (needs a decision or action by the
owner or the company's CA or lawyer), **Open** (still to do).

Confidence tags follow the owner's convention: [Certain] backed by a test or a reproduction, [Likely] a strong
inference from the code, [Guessing] a judgement that needs an expert.

## What was run

| Check | Result |
| --- | --- |
| Full check (typecheck, lint, unit and integration tests, every package) at `d26a58f` | Green: API 620 tests, web 36, owner 3, shared 19, desktop 4, bench 3 |
| Production builds (API, web, owner console) | Green |
| Browser suite (79 end-to-end flows) at `d26a58f` | 79 passed; after the upgrades 78, then 79 once D-21 was fixed |
| Demo reseed, crawl of every screen as every person, demo flows | First run: 172 failed seed steps, 1 flow failed (D-17, D-18). After the fixes: 0 failed steps, 19 of 19 passed |
| Dependency audit (`pnpm audit --prod`) | 3 moderate advisories (D-1 to D-3); none after the upgrades |
| Code hygiene scan (TODO/FIXME, `any`, `@ts-ignore`, lint suppressions) | Clean: no TODOs, no `any`, no `@ts-ignore`; 2 justified lint suppressions |
| Errors logged during the test run | 4, all expected (tests of bounce handling and bad templates) |
| Reading of the Wave 8 code for faults the tests do not reach | D-4 to D-16 |

## Findings

| # | Area | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| D-1 | Dependencies | `echarts` 6.0.0 has a cross-site scripting advisory (GHSA-fgmj-fm8m-jvvx), fixed in 6.1.0. Charts show names from the company's own data, so a stored name could reach it. [Likely] | Moderate | Fixed: upgraded to 6.1.0 |
| D-2 | Dependencies | `csv-parse` 6.x prototype replacement through the `columns` option (GHSA-8cw4-87c7-c6xx), fixed in 7.0.2. The BOQ CSV import does not use `columns`, so it is not reachable today. [Likely] | Moderate | Fixed: upgraded to 7.0.3 |
| D-3 | Dependencies | `uuid` below 11.1.1 (through `exceljs`): missing bounds check when a buffer is passed (GHSA-w5hq-g745-h8pq). `exceljs` never passes one. [Likely] | Moderate | Fixed: `exceljs>uuid` pinned to 11.1.1 in `pnpm-workspace.yaml`; `pnpm audit --prod` now reports none |
| D-4 | Scheduled work | The hourly loops for scheduled reports, nightly backups and the morning email guard only against running twice in one process. With two API processes (a second container, a rolling restart), each would take a backup and could send a report or email twice. [Likely] | Medium | Fixed (`9968637`): each loop runs under a database advisory lock, so only one process works at a time; tested |
| D-5 | Accounts | A migration that adds a system account skips it silently when its code is taken: the forfeiture account (8f.1) hit code I2003, already used, and was never created, so the role could not be mapped. Caught by its test and moved to I2005. Nothing checks that every account role resolves in a new company. [Certain] | Medium | Fixed (`9968637`): a test fails if any account role is unmapped in a new company |
| D-6 | Privacy | Anyone on a project's team, site workers included, could read flat buyers' PAN, phone and email through the sales screens. [Certain] | High | Fixed in 8g.4 (`d043473`): seeing sales is a permission; buyer details masked without the right to sell |
| D-7 | Privacy | Every user saw suppliers' full bank account numbers in the parties list. [Certain] | High | Fixed in 8g.4 (`d043473`): full number only for those who keep parties or read the books |
| D-8 | Backups | The restore check failed on every backup: `TRUNCATE` refused tables referenced by foreign keys. [Certain] | High | Fixed (`d26a58f`): truncate with `CASCADE`; the test now proves a restore matches table by table |
| D-9 | Backups | Backups hold the database only; stored files (bills, photos, drawings) are on the documents volume, and both sit on the same machine. [Certain] | Medium | Owner: copy `BACKUP_DIR` and the documents volume off the server (docs/backup.md) |
| D-10 | Languages | The same English word could be translated two ways in two screens, the last one silently winning everywhere ("Account" read as a bank account in the hindrance table; "Issue" a permit vs material; "To" until vs where). 16 clashes. [Certain] | Low | Fixed (`b83d069`): words with two senses carry them in the key; a test fails on any new clash |
| D-11 | Languages | The Marathi and Hindi wording was written without a native speaker's review. [Guessing] | Low | Owner: have a site supervisor read the screens in each language |
| D-12 | Morning email | Staff accounts never had an email address, so nobody receives the morning email until each person adds one; admins cannot set it for them. [Certain] | Low | Fixed (`9968637`): admins set a person's email on the Admin screen; tested |
| D-13 | Two-factor sign-in | It is optional for the company by default (to avoid locking out existing staff). [Certain] | Decision | Owner: turn on "require for admins and those who post to the books" in Two-factor sign-in |
| D-14 | Stores | Over-receipt within the order's tolerance: can it be billed? Verified: a bill is capped at what was accepted on receipt less what was billed before, so only goods received are payable. [Certain] | None | Accepted: correct as built |
| D-15 | Projects | Does the central store's internal project leak into project lists? Verified: lists exclude it; only stock screens see it. [Certain] | None | Accepted |
| D-16 | Tax and statutory | Figures and rules built from general knowledge, to be confirmed by the company's CA before use: TDS on a refund at cancellation; GST on forfeited amounts; 18% GST on transfer fees; the time limit for GST credit notes (CGST Act s.34); the RERA 70% share after refunds; the TDS return file layout (FVU); reverse charge categories; Rule 37 ITC reversal after 180 days; MSME 45-day payment rule; PF and ESI ceilings; Maharashtra professional tax slabs; bonus caps. [Guessing] | Decision | Owner: CA review before go-live |
| D-17 | Demo crawl | First reseed at the Wave 8 head: every screen opened cleanly for every person (14 crawls), but 1 of 5 demo flows failed (no order for the vendor to acknowledge) and the seeder logged 172 failed steps, against 1 at the end of Wave 7. [Certain] | Medium | Fixed: see D-18; after it, 0 failed seed steps and 19 of 19 crawls and flows passed |
| D-18 | Demo data and purchase | The causes of D-17. 124 subcontract bills held for labour compliance, because the seeder never recorded the contractors' PF and ESI challans (the 8c rule was working). 47 purchase orders refused as over budget, because the seeder gave no reason (the 8a.4 rule was working). Seen while tracing it, an app fault: an order over budget on amount only was reported as "Fly-ash bricks by 0 nos". [Certain] | Medium | Fixed (`02ae9a1`): the seeder records each month's challans by the 15th and gives a reason on orders; the message names the quantity, the ₹ amount, or both |
| D-19 | Tests | The nightly-backup test used the real clock, so it failed whenever it ran between midnight and 02:00 IST. [Certain] | Low | Fixed: the test runs at a fixed 03:30 IST |
| D-20 | Tests | The FIFO stores test provisions a second company inside the test with the default 5-second limit; under the full run's load it timed out (623 of 624 passed). Every other test that provisions a company allows 90 seconds. [Certain] | Low | Fixed: 90 seconds, like the rest |
| D-21 | Tests | After the ECharts upgrade the dashboards browser test failed: it expected the licence notice to say `echarts 6.0.0` and ECharts' 2025 copyright line, and the notice rightly said 6.1.0 and 2026. [Certain] | Low | Fixed: the test reads the version from the web app's `package.json` and accepts any copyright end year; 79 of 79 |
| D-22 | Offline outbox | Site entries kept on a device with no signal carried no record of who made them, so on a shared site tablet they were sent under whoever signed in next. Found while building the sign-out warning (Wave 9). [Certain] | High | Fixed (`fec91ec`): each entry keeps its author and is sent only while that person is signed in; tested |
| D-23 | Site photos | The web server's `Permissions-Policy` turned location off for the app itself (`geolocation=()`), so photos on the daily report never recorded where they were taken in the Docker deployment. Found while reviewing headers (Wave 9). [Certain] | Medium | Fixed: `geolocation=(self)` in deploy/Caddyfile |
| D-24 | Privacy, shared devices | The app keeps what it fetched in a cache, and nothing emptied it when someone signed out: the next person signing in on the same device could briefly see the previous person's lists, and (found by the browser suite) was not asked to accept the terms because the previous person's answer was still cached. [Certain] | High | Fixed: the cache is emptied on signing in, on signing out and when a session is lost; the terms state is kept per person |
| D-25 | Leaving a page (Wave 9's own) | Two faults in the new unsaved-changes warning, caught by the browser suite before release: changing a filter counted as unsaved work, so following a link asked "Leave without saving?"; and the warning's check answered asynchronously even when nothing was unsaved, so the redirect after signing out repeated without end and the page froze. [Certain] | High | Fixed: filter forms (labelled so, or with nothing that submits them) never count; the check answers at once and is off when nobody is signed in |
| D-26 | Every screen (Wave 9 exit) | The demo crawl timed out for every person: each screen waited the full 10 s for the network to go quiet. When the page loads, the web app asks the server to renew the session; with no session the server answers 400, and the app never read that answer, so the browser kept the request open for as long as the page lived. The 401 the app drops before retrying a request had the same leak. Separately, the status bar asked the server for the company name before anyone had signed in (the app's frame is drawn for a moment after activation), which drew a 401 on every first visit. Users saw nothing, but any tool or proxy waiting for the page to go idle hung, and each open request holds a connection. [Certain] | Medium | Fixed: the app reads and drops every answer it does not use, and asks for the company only once signed in |

## Actions taken

| # | Action | Proof |
| --- | --- | --- |
| D-1 to D-3 | Upgraded `echarts` 6.0.0 → 6.1.0 and `csv-parse` 6.2.1 → 7.0.3; pinned `uuid` 11.1.1 under `exceljs` only. Note: pnpm reads overrides from `pnpm-workspace.yaml`; putting one in `package.json` silently drops the existing `unzipper` pin, so it went in the workspace file. | `pnpm audit --prod`: no known vulnerabilities; full check green |
| D-4 | Scheduled reports, nightly backups and the morning email each run under a Postgres advisory lock (`src/common/loop-lock.ts`). | `test/loop-lock.int.spec.ts` |
| D-5 | A test provisions a new company and fails on any account role that does not resolve to an account. | `test/wave8g.int.spec.ts` |
| D-6, D-7 | Buyer details and supplier bank numbers masked unless the person has the right to see them. | `test/wave8g.int.spec.ts` |
| D-8 | Restore truncates with `CASCADE`; every backup is restored into a scratch database and compared table by table. | `test/wave8g.int.spec.ts` |
| D-10 | Words with two meanings carry the meaning in the key; a test fails on any new clash. | `apps/web/src/i18n/i18n.test.tsx` |
| D-12 | Admins set a staff member's email on the Admin screen (`POST /api/tenant/users/:id/email`). | `test/wave8g.int.spec.ts` |
| D-17, D-18 | The over-budget message names what is over; the demo seeder records contractor challans and gives budget reasons. | Reseed: 0 failed steps; crawl and flows 19 of 19 |
| D-19 | The backup test uses a fixed clock. | Passes at any hour |
| D-20 | The FIFO test gets the 90-second limit the other provisioning tests have. | `test/inventory.int.spec.ts` 6 of 6 |
| D-21 | The licence-notice check follows the shipped ECharts version. | `tests/e2e/tests/dashboards.spec.ts` passes |
| D-22 | Outbox entries carry their author; others' wait for them. | `apps/web/src/offline/outbox.test.ts` |
| D-23 | Location allowed for the app's own pages. | deploy/Caddyfile; docs/hardening.md |
| D-24 | Cache emptied on sign-in, sign-out and lost sessions. | `tests/e2e/tests/first-run.spec.ts` (the worker is asked to accept the terms) |
| D-25 | Filters ignored; synchronous check, off when signed out. | `apps/web/src/lib/unsaved.test.ts`; `first-run.spec.ts`, `quality.spec.ts`, `leaving.spec.ts` |
| D-26 | Unused answers read to the end (`drain` in `apps/web/src/api/client.ts`); the status bar asks for the company only when someone is signed in. | `apps/web/src/api/client.test.ts`; demo crawl (below) |
| D-9, D-11, D-13, D-16 | Left for the owner: see each row. | — |

## Recommendations

1. [Certain] Copy `BACKUP_DIR` and the documents volume to another machine or cloud bucket every night (D-9). A backup on the same disk does not survive the disk.
2. [Likely] Turn on required two-factor sign-in for admins and anyone who posts to the books before real data goes in (D-13).
3. [Guessing] Have the CA go through D-16 line by line before the first GST or TDS return is filed from the app.
4. [Likely] Ask one supervisor each for Marathi and Hindi to read the site screens for a day (D-11); wrong words on a muster or permit cause real mistakes.
5. [Certain] Keep running the demo reseed and crawl at the end of every wave. It caught D-18, which no unit test did, because each rule was right on its own.
