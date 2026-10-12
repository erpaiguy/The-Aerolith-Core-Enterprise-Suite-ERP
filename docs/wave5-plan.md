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

## Step 1 in detail (planned before building)

**What is there.** [Certain] Documents are versioned and immutable (`doc.document_version`, keyed by document and
version number). Drawings are documents whose versions are revisions. Nothing reviews them.

**Status codes** (the company's): A approved, B approved with comments, C revise and resubmit, D rejected, seeded.
- Each code carries an **effect**: approve, approve with comments, return or reject.
- Codes can be renamed or added; the effects are fixed.
- [Likely] A stage's worst effect wins: reject, then return, then approve with comments, then approve.

**Workflow templates** (company-wide, or one project's):
- A name and stages in order.
- Each stage has reviewers: named users, the project's leads, the project's members, or holders of a designation
  (Wave 3).
- Each stage needs **everyone** or **anyone** to respond, and has a number of due days.

**A review** (RV-001… per project):
- A document version (a drawing's revision included), a workflow and a title.
- Stages run one after another. Each stage's reviewers are resolved when it starts, and it is due its days later.
- Each reviewer gives a code and a comment.
- **When a stage closes:**
  - A or B moves to the next stage. After the last stage the review is **approved**, "with comments" if any B.
  - C **returns** it to the author. They upload a new version and **resubmit**, which starts a new review of that
    version linked to the old one.
  - D **rejects** it.
- An "anyone" stage closes on its first response. An "everyone" stage closes when all have responded.
- The author can withdraw a review.

**Reminders and the inbox:**
- Reviewers are notified when their stage starts, the day before it is due, and on the due day if they have not
  responded.
- "Waiting on me" counts their open review tasks beside approvals.

**Rights:**
- Templates: `documents.edit`.
- Starting a review: the project's team.
- Responding: only the reviewers named on the task.
- Everyone on the project reads.

**Tests:**
- An integration test, a three-stage review:
  - Design, by a named engineer: A.
  - The project lead: C, so the review is returned.
  - A new version is resubmitted. Design B, the lead A, the client's representative (anyone of two) A, so the review
    is approved with comments.
  - Reminders and the inbox count.
  - A stranger refused, and a reviewer answering twice refused.
- A browser test: a template, a review started on a document, answered from "waiting on me".

## Step 1 delivered

[Certain] As planned, on its own engine (`dms` schema, migration 0060), separate from the purchase approvals:
- **Codes** A, B, C and D seeded with fixed effects. Codes can be relabelled or added (`documents.edit`). The worst
  effect at a stage wins (`review-rules.ts`, unit-tested).
- **Workflows** company-wide or for one project. Each stage is "everyone" or "the first answer", has due days, and
  reviewers who are named users, the project lead, project members or a designation's holders. Reviewers are resolved
  when the stage starts; a stage nobody can review refuses to start.
- **Reviews** RV-001… per project on a vault document's version. A version already in review is refused. C returns the
  review to its author, who resubmits a newer version as a new review linked to the old one. D rejects it. A and B move
  it on, and after the last stage it is approved, "with comments" if any B. In an "anyone" stage, the others' tasks are
  marked not needed.
- **Notices:** a notice when a stage starts, and reminders at 09:00 the day before and on the due day. They are cleared
  when the task closes. "Waiting on me" counts in the inbox and on the Reviews menu item.
- **Screen:** Reviews. It shows what is waiting on me, a project's reviews, starting one, responding with a code and
  comment, withdrawing and resubmitting, and building workflows stage by stage.
- **Tests:**
  - `review-rules.spec.ts`.
  - `reviews.int.spec.ts`: the three-stage review returned at the lead, resubmitted and approved with comments; the
    "anyone" stage; notices and the inbox; and the refusals.
  - The browser test `reviews.spec.ts`: a workflow, a drawing returned with C, revised, resubmitted and approved.

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

## Changed by the owner (2026-10-12)

- **Reviews run on their own review engine** (schema `dms`), not as stage rules added to the approval engine.
  - Reviews run in stages, in order or in parallel, and each reviewer returns a status code. The approval engine
    runs by amount levels, and nine document types already depend on it.
  - Reviews still show in "waiting on me".
- **Signing is a drawn signature on a canvas, only.** Aadhaar eSign, DSC tokens and any certifying agency are out of
  scope, so **step 6 is dropped**.
  - Internal sign-off (step 5) is the signature: drawn, placed on the PDF, with an audit certificate page.
  - The audit page records who signed, when, from which session, and the document's hash.
  - The Wave 5 exit check becomes:
    1. A drawing reviewed in three stages.
    2. Revised.
    3. Signed with drawn signatures.
    4. Issued on a transmittal.
    5. Acknowledged by the recipient through the expiring link.
