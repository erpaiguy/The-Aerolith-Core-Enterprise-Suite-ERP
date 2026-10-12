# Tally agent

Sends Aerolith Core's vouchers into a running Tally Prime on your network. See `docs/wave6-plan.md`, step 6.

## What it does

Every few minutes, the agent:

1. Asks your Aerolith server for vouchers not yet in Tally.
2. Imports each one into Tally through Tally's own HTTP server.
3. Tells Aerolith what Tally answered.

A voucher Tally refuses, such as one with a ledger missing in Tally, stays pending. Tally's message is shown in
Aerolith under **Settings › Integrations**. Fix the cause in Tally, and the voucher goes in on the next pass.

## Before the first run

1. **In Tally Prime:** open the company and turn on the HTTP server (F1 › Settings › Connectivity, port 9000).
2. **Put the ledgers and parties in first:** export them from **Accounts › Tally › Masters** in Aerolith and import
   that file in Tally once. Vouchers need their ledgers to exist.
3. **In Aerolith, as an admin:** make an API key with the `tally` scope under **Settings › Integrations**. Copy the
   company's id from **Settings › Companies**.

## Run

You need Node.js 20 or later; no packages are installed.

```sh
AEROLITH_URL=https://erp.example.in AEROLITH_KEY=aek1... AEROLITH_ENTITY=<company id> node agent.mjs
```

Optional settings:

- `TALLY_URL`: where Tally's HTTP server is (default `http://localhost:9000`).
- `EVERY_MINUTES`: how often to run (default `5`; `0` runs once and stops).

To keep it running, use the Windows Task Scheduler or a service wrapper.

## Keeping the key safe

The key reads every voucher of the companies its maker can see. Keep it only on the Tally PC, and revoke it in
Aerolith if that PC is replaced.
