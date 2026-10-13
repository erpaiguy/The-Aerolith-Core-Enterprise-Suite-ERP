# Trying Aerolith Core with demo data

A demo company on your own PC, filled with realistic records, with a sign-in for every kind of user. For trying the
app by hand only: the passwords are known, so never run this on an install with real data.

## What you need

- **Docker Desktop**, on Windows or macOS, or Docker Engine with Compose on Linux.
- An **authenticator app** on your phone: Google Authenticator, Microsoft Authenticator or similar. The tenant admin
  and the owner console require one.
- About 10 minutes for the first build.

## Run it

From the repository folder:

```sh
bash deploy/scripts/init-env.sh                       # once: makes deploy/.env with fresh secrets
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec api node dist/cli/demo-seed.js --demo
```

The last command:

- takes about a minute;
- prints every sign-in;
- writes them to `demo-credentials.txt` inside the API container. To copy that file out, run
  `docker compose ... cp api:/app/demo-credentials.txt .`.

It refuses to run a second time on the same database. To start over, run `docker compose ... down -v`, which deletes
the demo data.

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

The seeder prints the licence key, the authenticator secrets, the recovery codes and the API key, because they are
new on every install. The fixed passwords are these.

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
cd tests/e2e && DEMO_BASE_URL=http://localhost:8080 DEMO_JSON=<path to demo-credentials.json> \
  pnpm exec playwright test -c playwright.demo.config.ts
```
