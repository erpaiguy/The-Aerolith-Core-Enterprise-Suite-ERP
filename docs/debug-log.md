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
| Browser suite (79 end-to-end flows) at `d26a58f` | 79 passed |
| Demo reseed, crawl of every screen as every person, demo flows | See D-17 |
| Dependency audit (`pnpm audit --prod`) | 3 moderate advisories (D-1 to D-3) |
| Code hygiene scan (TODO/FIXME, `any`, `@ts-ignore`, lint suppressions) | Clean: no TODOs, no `any`, no `@ts-ignore`; 2 justified lint suppressions |
| Errors logged during the test run | 4, all expected (tests of bounce handling and bad templates) |
| Reading of the Wave 8 code for faults the tests do not reach | D-4 to D-16 |

## Findings

| # | Area | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| D-1 | Dependencies | `echarts` 6.0.0 has a cross-site scripting advisory (GHSA-fgmj-fm8m-jvvx), fixed in 6.1.0. Charts show names from the company's own data, so a stored name could reach it. [Likely] | Moderate | Open |
| D-2 | Dependencies | `csv-parse` 6.x prototype replacement through the `columns` option (GHSA-8cw4-87c7-c6xx), fixed in 7.0.2. The BOQ CSV import does not use `columns`, so it is not reachable today. [Likely] | Moderate | Open |
| D-3 | Dependencies | `uuid` below 11.1.1 (through `exceljs`): missing bounds check when a buffer is passed (GHSA-w5hq-g745-h8pq). `exceljs` never passes one. [Likely] | Moderate | Open |
| D-4 | Scheduled work | The hourly loops for scheduled reports, nightly backups and the morning email guard only against running twice in one process. With two API processes (a second container, a rolling restart), each would take a backup and could send a report or email twice. [Likely] | Medium | Open |
| D-5 | Accounts | A migration that adds a system account skips it silently when its code is taken: the forfeiture account (8f.1) hit code I2003, already used, and was never created, so the role could not be mapped. Caught by its test and moved to I2005. Nothing checks that every account role resolves in a new company. [Certain] | Medium | Open |
| D-6 | Privacy | Anyone on a project's team, site workers included, could read flat buyers' PAN, phone and email through the sales screens. [Certain] | High | Fixed in 8g.4 (`d043473`): seeing sales is a permission; buyer details masked without the right to sell |
| D-7 | Privacy | Every user saw suppliers' full bank account numbers in the parties list. [Certain] | High | Fixed in 8g.4 (`d043473`): full number only for those who keep parties or read the books |
| D-8 | Backups | The restore check failed on every backup: `TRUNCATE` refused tables referenced by foreign keys. [Certain] | High | Fixed (`d26a58f`): truncate with `CASCADE`; the test now proves a restore matches table by table |
| D-9 | Backups | Backups hold the database only; stored files (bills, photos, drawings) are on the documents volume, and both sit on the same machine. [Certain] | Medium | Owner: copy `BACKUP_DIR` and the documents volume off the server (docs/backup.md) |
| D-10 | Languages | The same English word could be translated two ways in two screens, the last one silently winning everywhere ("Account" read as a bank account in the hindrance table; "Issue" a permit vs material; "To" until vs where). 16 clashes. [Certain] | Low | Fixed (`b83d069`): words with two senses carry them in the key; a test fails on any new clash |
| D-11 | Languages | The Marathi and Hindi wording was written without a native speaker's review. [Guessing] | Low | Owner: have a site supervisor read the screens in each language |
| D-12 | Morning email | Staff accounts never had an email address, so nobody receives the morning email until each person adds one; admins cannot set it for them. [Certain] | Low | Open |
| D-13 | Two-factor sign-in | It is optional for the company by default (to avoid locking out existing staff). [Certain] | Decision | Owner: turn on "require for admins and those who post to the books" in Two-factor sign-in |
| D-14 | Stores | Over-receipt within the order's tolerance: can it be billed? Verified: a bill is capped at what was accepted on receipt less what was billed before, so only goods received are payable. [Certain] | None | Accepted: correct as built |
| D-15 | Projects | Does the central store's internal project leak into project lists? Verified: lists exclude it; only stock screens see it. [Certain] | None | Accepted |
| D-16 | Tax and statutory | Figures and rules built from general knowledge, to be confirmed by the company's CA before use: TDS on a refund at cancellation; GST on forfeited amounts; 18% GST on transfer fees; the time limit for GST credit notes (CGST Act s.34); the RERA 70% share after refunds; the TDS return file layout (FVU); reverse charge categories; Rule 37 ITC reversal after 180 days; MSME 45-day payment rule; PF and ESI ceilings; Maharashtra professional tax slabs; bonus caps. [Guessing] | Decision | Owner: CA review before go-live |
| D-17 | Demo crawl | Pending: results of the reseed and crawl at the Wave 8 head. | | Open |

## Actions taken

Filled in as each finding is cleared.
