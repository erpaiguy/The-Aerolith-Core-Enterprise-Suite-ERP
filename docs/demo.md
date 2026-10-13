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

**3. Fill in the demo company.** This takes about two minutes. It saves every sign-in to `demo-credentials.txt` in the
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
| Suresh, manager (projects, purchase, site) | `suresh` | `Site-Office-Demo-26` | No |
| Priya, manager (estimation, CRM, sales, accounts) | `priya` | `Site-Office-Demo-26` | No |
| Raju, site engineer (worker) | `raju` | `Site-Office-Demo-26` | No |
| Meena, site supervisor (worker) | `meena` | `Site-Office-Demo-26` | No |
| Shinde Steel Traders, vendor portal | `sales@shinde-steel.demo` | `Portal-Demo-2026` | No |
| Kale Constructions, subcontractor portal | `site@kale.demo` | `Portal-Demo-2026` | No |
| Zilla Parishad Washim, client portal | `ee.works@zpwashim.demo` | `Portal-Demo-2026` | No |
| Owner console operator | `owner@aerolith.demo` | `Aerolith-Console-Demo-26` | Yes: add the printed secret |

**Adding an authenticator secret:** in your authenticator app, choose "Enter a setup key". Type the printed secret
and pick "Time based". Each code works once, so wait for the next code if one is refused.

## What is in the demo company

Deshmukh Infra Pvt Ltd, a Vidarbha contractor that also builds one residential project:

- **CRM:** three leads.
- **Tenders:** two.
  - "Hostel block, Amravati", with a priced BOQ of five items.
  - "Primary health centre, Risod", with a steel RFQ sent to Shinde Steel.
- **Project "Zilla Parishad School, Washim"**, with one site and a team of four:
  - A cement and sand order, part received.
  - A steel order to Shinde Steel, waiting for their acknowledgement.
  - A brickwork and plaster work order to Kale Constructions, with a measurement.
  - A contract BOQ with measured work, and RA bill 1 submitted to ZP.
  - Today's daily report, with a photo.
  - A main store holding cement: 300 bags received, 120 issued.
  - Two drawings, and transmittal TR-001 sent to ZP for review.
  - Two employees with yesterday's attendance.
- **Real estate:** "Sai Residency, Akola", registered under MahaRERA. Tower A has four flats; flat 101 is booked,
  with its agreement made and a payment received.
- **Report builder:** a shared report, "Purchase orders by vendor".
- **Portals:** one user of each kind. Kale's plaster measurement is waiting for a manager to accept it.

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
