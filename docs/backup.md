# Backups, restore and the audit export

Wave 8 step 8g.2. What the app does, what the operator still has to do, and how to restore.

## What is backed up

Every company (tenant) database, every night, as one file:

- **What is in it.** Every table's rows, read in one consistent snapshot, plus the database's migration list and its
  sequence values. The format is a gzip stream of framed CSV with a SHA-256 hash per table
  (`apps/api/src/backup/backup-file.ts`). No extra software: plain Node and Postgres `COPY`.
- **When.** After the hour the company's admin sets (02:00 IST by default) on *Administration → Backups and audit
  export*, once a day. An admin can also take one at any time.
- **How many.** The last 14 by default (1 to 90). Older files are deleted from disk.
- **Where.** `BACKUP_DIR` (one folder per tenant), `/app/backups` in the Docker image, on its own named volume
  `backups`. Files are created readable by the API user only.
- **Proven.** On a server that runs the tenants' Postgres itself (`LOCAL_PG_ADMIN_URL` set), each backup is
  restored into a scratch database right after it is taken. The scratch database is migrated from nothing, the backup
  loaded, every table's row count and contents hash compared, then dropped. The result shows on the screen as
  *Restored and matched* or *Check failed* with the reason.

## What is not backed up here (the operator's job)

- **Stored files** (`DOCUMENT_DIR`: bills, photos, drawings, signed copies). They are on the `documents` volume and
  must be copied off the server with the volume backup.
- **The control plane database** (tenants, licences, the email outbox). Use `pg_dump` on the `pgdata` volume's
  server as for any Postgres.
- **Off-site copies.** A backup on the same disk as the database protects against mistakes, not against losing the
  machine. Copy `BACKUP_DIR` off the server (another disk, another site, or the company's own storage) on a schedule.
- **Tenants on Supabase.** Their databases are backed up by Supabase as well; the app's own backups of them work the
  same way but cannot be restore-checked on this server (no superuser there), and say so on the screen.

## Restoring

Into a new, empty database (a superuser connection; triggers are switched off while loading):

```sh
createdb tenant_restore
pnpm --filter @aerolith/api build
pnpm --filter @aerolith/api restore:backup /path/to/aerolith-20261017T020000-abcd1234.aeb.gz \
  postgres://postgres:...@127.0.0.1:5432/tenant_restore --replace
```

The tool migrates the target to the current version, refuses a backup taken by a newer version, loads everything in
one transaction (nothing changes if any table fails), and prints the row counts or the tables that did not match. To
bring a company back, point its `core.tenant_db` row at the restored database (or restore over its own database
during a maintenance window) and restart the API.

## The audit export

*Backups and audit export → Download the audit export*: a ZIP of CSV files, one per table, of the books
(vouchers and lines, bills, receipts, TDS, GST), payroll, HR, assets, procurement, projects, tenders, sales, parties
and the audit trail, read in one snapshot, with each company's trial balance as of the chosen date. Never in it:
passwords, sessions, API keys, webhook secrets, two-factor secrets; nor stored files.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DIR` | `./.backups` (`/app/backups` in Docker) | Where backup files are written |
| `BACKUP_WORKER` | on (off in tests) | The hourly loop that takes nightly backups |
| `LOCAL_PG_ADMIN_URL` | unset | Superuser URL; when set, backups are restore-checked |
