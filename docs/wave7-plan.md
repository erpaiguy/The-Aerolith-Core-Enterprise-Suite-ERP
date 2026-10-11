# Wave 7 Build Plan: v2 (AI, Collaboration, Productivity)

Scope: docs/01-mvp.md Wave 7 and docs/04-features.md W7. Released as **v2, after v1 is live**. Exit criterion:
**features measured against targets set at the start of the wave**.

**Planned years ahead of building.** [Certain] This is an outline with decisions to make, not a step-by-step plan:
docs/01-mvp.md deliberately defers the AI approach and the full productivity list to the start of the wave. It is
rewritten in full before Wave 7 starts, with v1's usage data in hand.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Read this first

- **[Certain] Training a general-purpose language model from scratch is not feasible** (docs/01-mvp.md). The options
  are classical machine learning on tenant data and **self-hosted open-weight models** run on your servers.
- **[Certain] No paid AI APIs** in the product (docs/licensing-policy.md): model weights must carry licences that
  allow commercial use without fees, checked per model; "open" model licences vary and some restrict use.
- **[Certain] Tenant data is used for training only with opt-in consent** (docs/01-mvp.md), and the DPDP Act applies
  to personal data in it. Per-tenant databases make cross-tenant training an explicit export, never an accident.
- **[Certain] v1 commitments that make this possible are already being kept:** structured history (audit log,
  revisions, events), exportable tenant data, and a model-serving interface behind a feature flag (to be added in
  Wave 6 at the latest).

## Candidate parts (to be chosen at the start of the wave)

| # | Part | What it could include |
|---|------|----------------------|
| 1 | **In-app chat** | One-to-one and group chat, project and tender channels, mentions, files from the document store, presence, search, retention rules; real-time over WebSockets from the same API |
| 2 | **Productivity** | To-do lists linked to any record, personal and team dashboards, saved filters and views everywhere, a calendar of the user's deadlines (tender dates, approvals, obligations), snooze, keyboard shortcuts, recent and favourites |
| 3 | **Classical ML** | Rate prediction from past tenders and orders; delay risk on activities from history; anomaly flags on bills (rates, quantities beyond measured); supplier delivery risk |
| 4 | **Assistant on open-weight models** | Questions over the tenant's own data ("what is owed to Vidarbha Cement?") answered through the API with the user's permissions; drafting (tender queries, notices, RFIs); BOQ item matching against the rate library |
| 5 | **Document understanding** | Extracting quantities and items from tender BOQs in PDF; reading supplier invoices into bills (Wave 3a step 4). OCR was excluded from v1 by decision, so this is new |

## Decisions to make at the start of Wave 7

1. Which parts, in which order, and the measurable target for each (for example "rate suggestions within 5% of the
   accepted rate for 70% of items").
2. Hosting for models: GPU servers in India (cost, residency) or CPU-only small models.
3. Consent and data handling for training, reviewed under the DPDP Act.
4. Whether the assistant may change data or only read and draft.

## Risks

1. [Likely] An assistant that answers from tenant data must enforce the same project and permission rules as the
   screens; it goes through the API as the user, never directly to the database.
2. [Guessing] Usage of chat inside an ERP competes with WhatsApp, which site teams already use.
