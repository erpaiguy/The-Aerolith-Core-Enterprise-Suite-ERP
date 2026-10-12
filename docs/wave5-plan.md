# Wave 5 Build Plan: Document Workflow

Scope: docs/04-features.md W5 (D1-D4). docs/01-mvp.md exit criterion: **signed and approved documents end to end**.

**Planned before Waves 2b-4 are built.** It extends two things that exist: Wave 1's document store (folders,
versions, search, retention, links) and Wave 2b's approval engine (P5), plus Wave 2b step 8's drawings register.
Each step is re-read with you before it starts.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Read this first

- **[Certain] Aadhaar eSign is a paid, per-signature service** through licensed providers; it is **not** in the free
  baseline (docs/04-features.md D2). It can sit behind an adapter if a tenant pays for it.
- **[Likely] Signing with a Digital Signature Certificate (DSC) needs the desktop app.** A DSC lives on a USB token;
  a browser cannot talk to the token without a separately installed signer utility. The Electron app (docs/app-shells.md)
  can reach it through PKCS#11 with permissively licensed libraries, so DSC signing is **desktop only**. Browser users
  get typed or drawn internal sign-off. [Guessing] Library choices are checked against docs/licensing-policy.md when
  built (the PDF signing and PKCS#11 bindings must be MIT/Apache/BSD).
- **[Certain] External parties (consultants, clients) do not have accounts.** Staff are the tenant's employees with
  usernames (docs/03-architecture.md §6). Until Wave 6's portals (G5), transmittals and RFIs go out as files or links
  and responses are recorded by staff. **Proposal:** a one-time, expiring, signed link for an external reviewer to
  view a transmittal and upload a response, with no account; decide in step 3.

## Decisions proposed at the start (change any you disagree with)

- **[Likely] Document review uses the approval engine** with stages instead of amount levels: a workflow template
  (for example Design review → Project manager → Client) assigns reviewers per stage; each review returns a status
  code. The engine gains "stages by role or person" beside "levels by amount"; requests already in flight keep their
  rules, as now.
- **[Likely] Status codes are the common A/B/C/D set** (A approved, B approved with comments, C revise and resubmit,
  D rejected), editable per tenant.
- **[Certain] Signatures are applied to a PDF version** and create a new version of the document; the unsigned
  version stays. A signed PDF is never edited.

## Steps

| # | Step | Features | Depends on |
|---|------|----------|------------|
| 1 | **Review workflows** | Workflow templates, stages, reviewers, status codes, comments, deadlines, reminders | P5, Wave 1 documents |
| 2 | **Mark-up and comments** | PDF viewer with comments pinned to a page and area, comment sheets, responses | step 1 |
| 3 | **Transmittals, RFIs, submittals** | Controlled issue, acknowledgement, response deadlines, registers | step 1 |
| 4 | **Controlled revisions** | Revision rules, superseded marking, issue status, distribution matrix | Wave 2b step 8 |
| 5 | **Internal sign-off** | Typed or drawn signature on PDFs, signature fields, audit certificate | step 1 |
| 6 | **Digital signatures (DSC)** | PAdES signatures with the signer's own certificate from the desktop app, verification | step 5 |

## Step 1: Review workflows (D1)

- Workflow templates per document type or folder: stages in order or in parallel, reviewers by project role, named
  person or (after Wave 3 step 11) custom role; due days per stage; what happens on C or D (back to the author).
- Starting a review on a document version; each reviewer's status code and comment; the overall outcome by rule
  (all A/B → approved).
- Reminders before and after the due date (in-app, as in Wave 0); "waiting on me" includes reviews.
- **Tests:** a three-stage review with one C sending it back and a resubmitted version approved.

## Step 2: Mark-up and comments (D1)

- A PDF viewer (pdf.js, Apache-2.0, already in use for Wave 1 thumbnails and search) with comments pinned to a page
  region; replies; resolved state.
- A comment sheet export (Excel/PDF) per review, the format consultants exchange today.
- [Likely] Drawing mark-up with shapes (clouds, arrows) is wanted; it is kept to comments plus a highlight box in this
  wave.

## Step 3: Transmittals, RFIs, submittals (D3)

- **Transmittals:** a set of document versions issued to recipients (internal, consultant, client, subcontractor) for
  a purpose (for information, review, construction), numbered, with acknowledgement tracking and response due dates.
- **RFIs:** a question from site with references (drawing, location, BOQ line), routed to the designer, the response
  recorded; an RFI can lead to a variation (Wave 4 step 4) or a revised drawing.
- **Submittals:** shop drawings, method statements, material submittals sent for approval with status codes, linked
  to Wave 3's material approvals.
- Registers for each, with overdue responses highlighted.

## Step 4: Controlled revisions (D4)

- Revision rules per project (P1, P2 for preliminary; 0, 1, 2 for construction; or A, B, C), enforced on upload.
- Issue status on each revision (for information, for approval, for construction), superseded marking extended from
  Wave 2b step 8 across all controlled documents, a **distribution matrix** (who gets which disciplines), and a site
  check "is this the current revision?" by scanning a QR printed on the drawing.

## Step 5: Internal sign-off (D2)

- Signature fields placed on a PDF; signers sign with a typed or drawn signature in order; a signed version is
  produced with a visible stamp, and an **audit certificate** page (who, when, from which session, document hash).
- Used by approvals: an approved review can require signatures before the document is issued.

## Step 6: Digital signatures with DSC (D2)

- In the desktop app: choose the certificate on the token, sign the PDF as **PAdES** (with a timestamp from a
  configurable RFC 3161 server; a free one by default, the tenant may set their own), the signed version uploaded.
- Verification of signed PDFs on upload (signature valid, certificate chain, revoked or not where reachable).
- **Exit check for Wave 5:** a drawing reviewed in three stages, revised, issued on a transmittal, signed with a DSC,
  acknowledged by the recipient.

## Risks

1. [Likely] DSC tokens from different vendors ship different drivers; support will hit token-specific problems.
2. [Guessing] Clients and consultants may refuse to work through links and keep using email; the register then
   records what happened outside the app.

## Questions for you before Wave 5 starts

1. Which status code set do your consultants use?
2. Is DSC signing needed for your own documents, or only for statutory submissions?
3. Expiring links for external reviewers: acceptable, or wait for the Wave 6 portals?

## Answers taken (2026-10-12: "start wave 5 with your recommended defaults")

1. **Status codes:** A approved, B approved with comments, C revise and resubmit, D rejected. Each company can rename
   them or add its own.
2. **DSC signing** is for statutory submissions only (it needs the desktop app and the signer's USB token). Everything
   else uses internal sign-off with a typed or drawn signature.
3. **External reviewers** get an expiring, signed link (no account) to view what was sent and upload their response,
   recorded against the transmittal. The Wave 6 portals replace it later.
