# Email Delivery

Code: `apps/api/src/email`. Migration: `control-plane/0004_email.sql`.

Everything the system emails (licence key, admin set-password link, admin reset link, "password changed" notice,
Supabase onboarding link, trial changes, owner test message) is first written to `core.email_outbox`, then sent by the
email worker inside the API. Links and licence keys are stored sealed and decrypted only in memory while sending.

## How delivery works

| Step | Behaviour |
|------|-----------|
| Claim | Every 10 s the worker takes up to 20 due emails with `FOR UPDATE SKIP LOCKED`, so two API processes never send the same email |
| Send | Outside any database transaction, through the configured adapter |
| Success | `sent`, with the provider's message id; licence emails add an `emailed` licence event |
| Temporary failure (timeouts, 4xx, wrong password, sender not allowed) | Stays `queued`; retried after 1 min, 5 min, 15 min, 1 h, 3 h. The sixth failure is final (`failed`). Configuration problems never discard customer emails before you can fix them |
| Address rejected (5xx to RCPT TO) | `failed` and the address is added to the **suppression list**; later emails to it become `suppressed` without being sent |
| Message rejected (5xx to DATA) | `failed` for that email only |
| Crash while sending | After 10 minutes the email returns to the queue (at-least-once delivery: a rare duplicate is possible) |
| Hourly cap | `EMAIL_MAX_PER_HOUR` (default 60) protects the mailbox's sending limit; the rest wait for the next hour |

Owner console routes (operator sign-in): `GET /owner/emails[?status=]`, `GET /owner/emails/summary`,
`POST /owner/emails/:id/retry`, `POST /owner/emails/test {email}`, `GET /owner/email-suppressions`,
`POST /owner/email-suppressions {email}`, `POST /owner/email-suppressions/remove {email}`. They never return links,
keys or message bodies.

## Settings (`apps/api/.env`)

| Variable | Meaning |
|----------|---------|
| `EMAIL_TRANSPORT` | `smtp` (real sending), `file` (writes `.eml` files to `EMAIL_FILE_DIR`; development default), `disabled`. **Required in production.** |
| `EMAIL_FROM` | e.g. `Aerolith Core <no-reply@your-domain.in>`; must be an address your mailbox may send as |
| `EMAIL_REPLY_TO`, `SUPPORT_EMAIL` | Optional; support address appears in every email footer |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | Mailbox SMTP settings (below) |
| `SMTP_REQUIRE_TLS` | Always `true` in production (unencrypted SMTP is refused) |
| `EMAIL_MAX_PER_HOUR` | Hourly cap, default 60 |

## Your GoDaddy mailbox: which product do you have?

GoDaddy sells two different email products and they need different settings. In your GoDaddy account, open
**Email & Office**: the product name says either *Microsoft 365* or *Professional Email / Workspace Email*.

| | Professional Email / Workspace Email | Microsoft 365 from GoDaddy |
|---|---|---|
| `SMTP_HOST` | `smtpout.secureserver.net` | `smtp.office365.com` |
| `SMTP_PORT` / `SMTP_SECURE` | `465` / `true` (or `587` / `false` if 465 is blocked) | `587` / `false` |
| `SMTP_USER` / `SMTP_PASSWORD` | Full email address / mailbox password | Full email address / mailbox password |
| Daily limit | [Guessing] about 250-500 messages per day depending on plan; third-party sources disagree, check your plan | [Guessing] varies by plan; small plans have low limits |
| **Risk** | Low | **High: Microsoft plans to switch off password-based SMTP by default at the end of December 2026** (it can be re-enabled by the tenant admin for now, and full removal is planned for 2027). Our sender uses password sign-in. GoDaddy-managed Microsoft 365 tenants often don't give you the admin controls to re-enable it |

**Recommendation:** if you have Microsoft 365 from GoDaddy, plan to switch the sending mailbox before December 2026,
either to a GoDaddy Professional Email mailbox or to a transactional email service with a free tier that offers SMTP.
Only `.env` settings change; the code is provider-neutral.

## DNS records (at GoDaddy) so mail is not marked as spam

| Record | Purpose | Notes |
|--------|---------|-------|
| SPF (TXT on the domain) | Lists who may send for your domain | Professional Email: include `secureserver.net`; Microsoft 365: include `spf.protection.outlook.com`. Only **one** SPF record per domain |
| DKIM | Signs messages | Enable it in the email product's settings; it gives you the records to add |
| DMARC (TXT on `_dmarc`) | Tells receivers what to do with failures | Start with `v=DMARC1; p=none; rua=mailto:<your address>`, move to `quarantine` after a few weeks of clean reports |

## Check that it works

1. Set the variables, restart the API, sign in to the owner console.
2. `POST /api/owner/emails/test {"email": "<your address>"}`.
3. Within ~10 s: `GET /api/owner/emails?limit=5` shows `sent` (or `lastError` explaining the problem).
4. Check the message arrived in the inbox, not spam. If it went to spam, finish the DNS records above.

## Not handled yet

Bounces that arrive later as reply emails (non-delivery reports to the mailbox) are not read automatically; only
bounces the SMTP server reports immediately are. Unsubscribe handling is not needed for these transactional emails.
