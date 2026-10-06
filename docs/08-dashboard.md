# Phase 8: Dashboard (draft v0)

Two separate dashboard products: the **owner console** (our side, control plane) and **tenant dashboards** (inside the
app, tenant's own Supabase). Personal/custom dashboards are v2 (Wave 7). v1 ships **fixed dashboards per role and per
module**, with filters.

## 1. Rules for every dashboard

| Rule | Detail |
|------|--------|
| Speed | Each widget answers in < 300 ms. KPIs come from **summary tables maintained incrementally** (same rollup idea as BOQ subtotals), never from scanning 1M-row tables on load |
| Freshness | Each widget shows "as of" time. Operational widgets (deadlines, pending approvals) are live; analytical ones may lag up to a few minutes |
| Filters | Entity/branch (GSTIN), financial year, date range, project/tender, owner/user |
| Drill-down | Every number opens the list behind it. No dead-end numbers |
| Permissions | A widget shows only data the user's role and project scope allow. Worker dashboards never show values they cannot open |
| Export | PDF and Excel of any dashboard view |
| Charts | Apache ECharts (Apache-2.0, canvas, handles large series). Complies with the licensing policy |
| Responsive | Works in the Electron window, browser, and phone-width browser |
| Empty states | Every widget explains what to do when there is no data yet (matters for trial tenants) |

## 2. Tenant dashboards, v1

### 2.1 Home (every user)
Pending actions inbox (approvals, password-reset requests for admins, reminders), upcoming deadlines (next 14 days),
recent items, notices from the owner (trial changes, updates).

### 2.2 Admin
| Widget | Why |
|--------|-----|
| Licence: tier, seats used / cap, trial or renewal date, auto-renew status | Avoid surprise lapses |
| Users: active, deactivated, pending reset requests, last login | Seat and security hygiene |
| **Supabase health:** database size vs plan limit, storage used vs limit, project status (active/paused) | Warns *before* the free tier fills or pauses (05 §11) |
| **Backup/export status:** last tenant export, size, next scheduled | Free tier has no backups (infra §5) |
| App version and update available | Same channel as owner notices |

### 2.3 Tender and bid (Wave 1)
Pipeline by stage (count and value), submission deadlines calendar, pre-bid and query due dates,
**EMD/BG expiring in 30 days** and pending returns, bid/no-bid outcomes, win rate and win value by period, client and
segment (Buildings / Interiors / Joineries / MEP), quote-comparison status of open RFQs.

### 2.4 Estimation (Wave 1)
BOQs in progress per estimator, BOQ value by tender and version, revision count and value change between versions,
cost breakdown (material / labour / equipment / subcontract / overhead / profit), rate-library items changed recently.

### 2.5 Later waves (defined when each wave starts)
| Wave | Dashboards |
|------|-----------|
| 2a | Project portfolio, schedule status (planned vs actual %, critical activities, delayed milestones), look-ahead |
| 2b | Procurement (open PR/PO, overdue deliveries), inventory (stock value, below reorder), daily site report compliance |
| 3 | Finance (cash, receivables/payables ageing, GST/TDS due), billing vs progress, equipment utilisation, HR attendance, quality/safety stats |
| 4 | Cost control: budget vs committed vs actual vs forecast, EVM (CPI/SPI), variations |
| 5 | Document review status, overdue approvals, signature queue |
| 6 | CRM pipeline, sales/RERA, BI report builder |

## 3. Owner console dashboard (control plane)

| Area | Widgets |
|------|---------|
| Growth | Downloads by day/platform/version, signups, email-verified rate, **Supabase-connect completion rate** (the extra onboarding step, 05/infra §5), trial-to-paid conversion |
| Trials | Active trials, ending in 7/30 days, extended/shortened, inactive trials (no login in 14 days) |
| Licences and seats | Seats issued vs used, tenants near cap, **seat-reassignment abuse report** (Phase 6) |
| Revenue (after commercial) | MRR/ARR, renewals due, auto-renew failures, disputes |
| Fleet health | Tenant projects paused/unreachable/near limit, **schema version per tenant**, migration rollouts and failures |
| Delivery | Licence-email delivery, bounces, GoDaddy send-limit headroom |
| Releases | Version adoption, mandatory-update compliance |
| Security | Failed logins, key-lookup spikes, webhook signature failures |

The owner console reads only control-plane data plus health metadata (sizes, status, schema version) reported by each
tenant app. It never reads tenant business data, which lives in the tenant's own Supabase.

## 4. Open questions

1. For the Wave 1 tender dashboard, which **three numbers** does a contractor owner look at first? I proposed upcoming deadlines, pipeline value, and EMD/BG expiries.
2. Should the tenant's usage metrics (logins, module usage counts) be sent to the owner console for product decisions? That is **telemetry** and needs an opt-in or a clear statement in the privacy policy (DPDP).
