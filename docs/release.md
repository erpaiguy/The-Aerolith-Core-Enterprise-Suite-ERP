# Releases and updates (Wave 9, steps 9b.4 and 9b.6)

How a version of Aerolith Core is numbered, built, signed and published, and how installations learn of it and update.
No paid service is involved: releases are GitHub releases (or any plain file host), and the release manifest is signed
with a key only the publisher holds.

## Version numbers

- One version for the whole product, in the root `package.json`; the desktop app's `package.json` must match.
  `node tools/release/version.mjs` prints it, `node tools/release/version.mjs 1.0.0` sets it, and CI fails if they
  differ (`--check`).
- Semantic versioning: `MAJOR.MINOR.PATCH`. A patch fixes; a minor adds without breaking; a major may need people to
  learn something new or an administrator to act. Pre-releases are `1.0.0-rc.1`.
- The web app shows the version in the status bar; the server reports it at `/api/health` and `/api/updates`; the
  desktop app in Settings.
- Wave 9 is `0.9.0`. `1.0.0` is the first version for customers, after the legal drafts are reviewed (below).

## Keys (once, by the publisher)

1. On a trusted machine: `node tools/release/keygen.mjs`. It prints `RELEASE_PUBLIC_KEY=…` and `RELEASE_SIGNING_KEY=…`.
2. Put `RELEASE_SIGNING_KEY` in the repository's Actions secrets (Settings → Secrets and variables → Actions) and in
   a password manager. Never commit it, paste it in chat, or keep it on a server. Losing it means a new key and a
   manual update of every installation; leaking it means anyone could sign an update, so a leaked key must be
   replaced at once the same way.
3. Put `RELEASE_PUBLIC_KEY` in the repository's Actions variables (it is built into the desktop app) and in each
   server's `deploy/.env` with `UPDATE_MANIFEST_URL` (below).

## Making a release (checklist)

1. All of the Progress list for the wave is ticked; `pnpm check` and the browser suite pass on `main`; the demo
   reseed and crawl are clean.
2. Read `docs/debug-log.md`: nothing Open that a customer would meet.
3. `node tools/release/version.mjs 1.2.0` and `node tools/release/changelog.mjs 1.2.0 --write`; edit the new
   CHANGELOG section into plain words where a commit subject is too technical; commit "Release 1.2.0".
4. A new database migration is never edited after release; check the new ones apply to a copy of a real database
   (restore a backup, start the new version against it).
5. Tag and push: `git tag v1.2.0 && git push origin v1.2.0`. The Release workflow builds the Windows installer
   (code-signed when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set — a code-signing certificate is bought from a
   certificate authority; without one Windows shows an "unknown publisher" warning, and the app still checks its own
   updates by signature), writes the manifest with each installer's SHA-256, signs it, and publishes
   `AerolithCore-Setup-1.2.0.exe` and `latest.json` as a GitHub release.
6. Check the release page; install it on a clean Windows machine; sign in; open a few screens.
7. If a release must be withdrawn: delete the GitHub release (installations keep the version they have) and publish
   a fixed patch version. Never re-use a version number.

## How installations learn of a release

- **Server**: set in `deploy/.env`
  - `UPDATE_MANIFEST_URL=https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
  - `RELEASE_PUBLIC_KEY=<the public key>`

  The server reads the manifest once a day (and when an admin presses "Check now" in Settings → Company), checks its
  signature, and tells the sign-in screen, the status bar and the desktop apps. A manifest that fails the check is
  ignored and the reason shown in Settings. A private repository's release files need a token to download, so for a
  private repository host `latest.json` and the installers on any public file host instead and point
  `UPDATE_MANIFEST_URL` there.
- **Desktop app**: checks the same manifest through the server, verifies the signature with the key built into it,
  downloads the installer, checks its SHA-256, and installs it when the app next closes (automatic, the default) or
  when the person chooses "Restart and update" (manual). The choice is in Settings → This device.
- **Browser**: the web app is served by the server, so it is updated when the server is.

## Updating a server

1. Take a backup (Backups → Back up now) and wait for "Restored and matched". Copy it off the machine.
2. On the server: `git fetch --tags && git checkout v1.2.0`.
3. `cd deploy && docker compose up -d --build`. The API applies new migrations to the control database and each
   company's database on start; the web server starts serving once `/api/health/ready` answers.
4. Sign in and check the version in the status bar. If something is wrong, `git checkout` the previous tag and
   `docker compose up -d --build` again; a migration that already ran stays, so if it must be undone, restore the
   backup from step 1 (`pnpm --filter @aerolith/api restore:backup`).

## Before the first customer

- The legal documents are drafts (docs/wave9-plan.md, Settings → Company → Legal documents): a lawyer reviews them,
  the bracketed placeholders are filled in, and an admin marks each version reviewed.
- Tax and statutory figures: the CA review in docs/debug-log.md D-16.
- A code-signing certificate for the Windows installer (optional but advised).
