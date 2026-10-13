# Trying Aerolith Core with demo data

A demo company on your own PC, filled with realistic records, with a sign-in for every kind of user. For trying the
app by hand only: the passwords are known, so never run this on an install with real data.

## What you need

- **Docker Desktop**, running. On Windows, use the default WSL 2 backend. Nothing else needs to be installed: no
  Node, Python or OpenSSL.
- **The code from the `claude/vibrant-allen-0cxizs` branch.** Either:
  - clone it: `git clone -b claude/vibrant-allen-0cxizs https://github.com/erpaiguy/The-Aerolith-Core-Enterprise-Suite-ERP.git`;
  - or on GitHub, switch to that branch, then Code › Download ZIP, and unzip.
- An **authenticator app** on your phone: Google Authenticator, Microsoft Authenticator or similar. The tenant admin
  and the owner console require one.
- About **15 minutes** for the first build, and roughly 3 GB of disk for the images.

## Run it

Open **PowerShell** (Windows) or **Terminal** (macOS or Linux) in the repository folder. The commands are the same in
both.

**1. Make the secrets file, once.** This creates `deploy/.env`; keep that file private.

```sh
docker run --rm -v "${PWD}/deploy:/deploy" node:22-bookworm-slim node /deploy/scripts/init-env.mjs
```

**2. Build and start.** The first time takes 10 to 15 minutes; later starts take seconds.

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

**3. Fill in the demo company.** This replays the company's history from January 2024 to today and takes 15 to 30
minutes; it prints its progress month by month. It saves every sign-in to `demo-credentials.txt` in the
repository folder; open that file with any text editor.

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec -T api node dist/cli/demo-seed.js --demo > demo-credentials.txt
```

Keep that file: the licence key and the authenticator secrets in it are made once, and cannot be shown again. If you
lose it, start over as described under "Throw everything away" below. The file is ignored by Git.

**Day to day:**

- **Stop:** `docker compose --env-file deploy/.env -f deploy/docker-compose.yml stop`. The data is kept.
- **Start again:** the same command with `start`.
- **Throw everything away and seed again:** run `down -v` instead of `stop`, then steps 2 and 3. `down -v` deletes all
  data.

If a port is busy (8080 or 8081), change `WEB_PORT` or `OWNER_PORT` in `deploy/.env` and run step 2 again.

## Where to sign in

| Entry point | Address | Who |
|---|---|---|
| Web app | http://localhost:8080 | The tenant admin and the staff |
| Portal | http://localhost:8080/portal/<tenant id> (the seeder prints the full link) | The vendor, subcontractor and client |
| Owner console | http://localhost:8081 | You, as the operator selling licences |
| Public API | http://localhost:8080/api/v1 (documentation: `/api/v1/openapi.json`) | Programs, with the printed API key |

The first time a browser opens the web app, it asks for the **licence key**. The seeder prints it. Enter it once per
browser.

## The sign-ins

`demo-credentials.txt` holds the licence key, the authenticator secrets, the recovery codes and the API key, because
they are new on every install. The fixed passwords are these.

| Who | Sign in with | Password | Authenticator |
|---|---|---|---|
| Tenant admin | `admin@deshmukh-infra.demo` | `Deshmukh-Infra-Demo-26` | Yes: add the printed secret to your app |
| Suresh, projects manager (manager) | `suresh` | `Site-Office-Demo-26` | No |
| Priya, estimation and contracts manager (manager) | `priya` | `Site-Office-Demo-26` | No |
| Kavita, accounts executive (manager) | `kavita` | `Site-Office-Demo-26` | No |
| Imran, purchase and stores officer (manager) | `imran` | `Site-Office-Demo-26` | No |
| Pooja, HR and admin executive (manager, with HR and payroll rights) | `pooja` | `Site-Office-Demo-26` | No |
| Rahul, QA/QC and safety officer (manager) | `rahul` | `Site-Office-Demo-26` | No |
| Raju, site engineer (worker) | `raju` | `Site-Office-Demo-26` | No |
| Meena, site supervisor (worker) | `meena` | `Site-Office-Demo-26` | No |
| Nikhil, site engineer (worker) | `nikhil` | `Site-Office-Demo-26` | No |
| Snehal, junior site engineer (worker) | `snehal` | `Site-Office-Demo-26` | No |
| Shinde Steel Traders, vendor portal | `sales@shinde-steel.demo` | `Portal-Demo-2026` | No |
| Kale Constructions, subcontractor portal | `site@kale.demo` | `Portal-Demo-2026` | No |
| Zilla Parishad Washim, client portal | `ee.works@zpwashim.demo` | `Portal-Demo-2026` | No |
| Owner console operator | `owner@aerolith.demo` | `Aerolith-Console-Demo-26` | Yes: add the printed secret |

**Adding an authenticator secret:** in your authenticator app, choose "Enter a setup key". Type the printed secret
and pick "Time based". Each code works once, so wait for the next code if one is refused.

## What is in the demo company

Deshmukh Infra Pvt Ltd, a building contractor in Washim (Maharashtra), founded in January 2024 with ₹1 crore of
share capital. The seeder replays its life day by day up to today, through the app's own screens' API, so every
register, ledger and dashboard holds two and a half years of consistent history. All figures are illustrative.

- **Size:** about ₹2.1 crore of work in FY 2024-25, ₹2.7 crore in FY 2025-26, and on the same pace in 2026-27. A
  ₹50 lakh cash-credit limit carries the working capital.
- **People:**
  - 13 staff have been engaged and 10 are on the rolls today, across projects, estimation, accounts, purchase, HR,
    quality and safety, and site. One resigned in 2025, one was terminated in 2025, one resigned in 2026; each has a
    full-and-final settlement. Their sign-ins are turned off.
  - Raises every April, leave, monthly biometric punches, 33 payroll runs with PF, ESI, PT and TDS paid on time.
  - About 250 labourers engaged over the years through three labour contractors, hired as the sites needed them and
    leaving as jobs ended, with a daily muster at every site and monthly wage sheets.
- **Estimation:** a priced rate library with quarterly price history, eleven rate analyses (overheads and profit),
  and about 25 tenders priced from them, with bid decisions, EMDs, checklists, submissions, competitors' bids and
  results (won, lost on price, no-bid). Leads in the CRM, some converted to tenders, some open in the pipeline.
- **Ten projects won by tender:**
  - Two finished in 2024 and two in 2025, with retention released after the defects period, then closed.
  - Two finished in August and September 2026.
  - Two nearing completion (Zilla Parishad School, Washim; Community Hall, Akola).
  - Two running into 2027 (Hospital OPD block, Malkapur; Police staff quarters, Washim).
  - Each has its contract and budget BOQs from the tender, a WBS, a baselined programme updated monthly, a contract
    register, monthly measurements, RA bills certified and paid, work orders to the labour contractors with their
    measurements and bills, daily reports for every working day (manpower, machines, weather, hindrances),
    fortnightly requisitions and purchase orders, deliveries into the site store, weekly issues, concrete tests,
    inspections, toolbox talks, incidents, drawings, RFIs, variations, risks and monthly cost-control closes.
- **Accounts:** every bill, receipt, payment, payroll, GST return payment, TDS challan, depreciation run and machine
  costing posted; FY 2023-24, 2024-25 and 2025-26 closed. Statements, trial balance, receivables, payables and cash
  flow all read from them.
- **Real estate:** Sai Residency, Akola, registered under MahaRERA in March 2026: 32 flats, 14 booked with their
  agreements and payments, and collections moved to the RERA account.
- **Today:** a steel order waiting for Shinde's acknowledgement, Kale's measurement waiting under Portal submissions,
  a steel RFQ on the open tender, a transmittal to ZP, approval rules with an order and a leave request waiting, and
  a permit to work issued for today.

## Things worth trying

1. **Shinde, on the vendor portal:**
   - Under Enquiries, quote the steel RFQ.
   - Under Orders, acknowledge the steel order.
2. **Kale, on the subcontractor portal:**
   - Send another measurement.
   - Upload an invoice (any PDF).
3. **Suresh:**
   - Open Portal submissions and accept Kale's measurement and Shinde's quote.
   - The quote then appears in the RFQ's comparative statement.
4. **ZP, on the client portal:** see RA bill 1 and the site photos, and respond to TR-001.
5. **Raju, offline, from a phone or a browser in offline mode:**
   - Receive goods against the cement order.
   - The receipt waits in the Outbox, and is sent once when the signal returns.
6. **Priya:** in Sales and RERA, choose Sai Residency, then on the Payment plan tab mark "Plinth" reached and watch
   the demand appear on flat 101's booking.
7. **Tenant admin:** under Settings › Integrations, make an API key, and call `/api/v1/views` with `curl`.
8. **The operator, in the owner console:** raise the portal-user limit on the licence.

## What it is not

- **Not online.** The demo runs only on your PC. Putting it on the internet needs a server, a domain and HTTPS
  ([deployment-docker.md](deployment-docker.md)), and real secrets instead of demo passwords.
- **No email is sent.** The install writes messages to its outbox folder (`EMAIL_TRANSPORT=file`).

## How it was checked

Two browser tests run against a freshly seeded stack.

`tests/e2e/demo/flows.spec.ts` does items 1 to 4 and 6 of the list above, as those people.

`tests/e2e/demo/crawl.spec.ts` signs in as every person above. It opens every screen in their menu and the detail
page of every seeded record, and fails on:

- an error in the page;
- any API request answered 4xx or 5xx;
- any red error banner.

To run it against your stack:

```sh
cd tests/e2e && DEMO_BASE_URL=http://localhost:8080 DEMO_CREDENTIALS=../../demo-credentials.txt \
  pnpm exec playwright test -c playwright.demo.config.ts
```
