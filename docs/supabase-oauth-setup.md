# Supabase OAuth App: Setup, Apply, and Verify

This lets the app create each tenant's Supabase project **inside the tenant's own Supabase organisation** after the
tenant clicks "Connect your Supabase" once (docs/infra-existing-stack.md §5, docs/tenant-provisioning.md).

Tags: [Certain] confirmed in Supabase's documentation; [Likely] strong inference; [Guessing] check on screen.
Supabase changes its dashboard often. If a label differs from what is written here, follow the meaning, not the exact words.

---

## Part A. Before you start (prerequisites)

| # | What | Why |
|---|------|-----|
| A1 | **A public HTTPS address for the API**, e.g. `https://api.<your-domain>`. During the owner-PC stage this is the Cloudflare Tunnel hostname pointing at the API on your PC (docs/10-deployment.md §10.1) | Supabase sends the tenant's browser back to this address after consent. It must be reachable from the internet and must be HTTPS |
| A2 | **Decide the exact callback URL now:** `https://api.<your-domain>/api/onboarding/supabase/callback` | [Certain] The redirect URI sent during login must match a registered one exactly. Our API builds it from `PUBLIC_API_URL` + `/api/onboarding/supabase/callback`, so the two must agree character for character (no trailing slash, same host, `https`) |
| A3 | MFA enabled on your Supabase account | This OAuth app can create projects in customers' organisations. Your Supabase login protects it (docs/09-security.md §7) |
| A4 | A **second Supabase account** (different email) to act as a test tenant | Proves that an organisation which is *not yours* can authorise the app (Part D) |
| A5 | The API built and its secrets generated: `pnpm --filter @aerolith/api build` then `pnpm --filter @aerolith/api secrets:generate` | The `.env` file in Part C needs them |

**Protect the owner routes before you open the tunnel.** The tunnel makes the whole API public, including `/api/owner/*`,
which require an operator sign-in with mandatory MFA. Still, block `/api/owner/*` from the internet at whatever
tunnel or proxy you use, and call those routes only from your PC via `http://127.0.0.1:3000`.

---

## Part B. Create the OAuth app in Supabase

1. Sign in at **supabase.com/dashboard** with your own (owner) account.
2. Open **your organisation** (the one that holds the control-plane project), then its **organisation settings**.
3. Open the **OAuth Apps** tab and click **Add application** (upper right). [Certain: Supabase docs]
4. Fill in the form:

   | Field | Value |
   |-------|-------|
   | Application name | `Aerolith Core` (tenants see this on the consent screen) |
   | Website URL | `https://<your-domain>` |
   | Icon / logo (if offered) | Your app logo. It appears on the consent screen and builds trust |
   | Authorization callback URL(s) / Redirect URI(s) | `https://api.<your-domain>/api/onboarding/supabase/callback` |
   | Scopes / permissions | See the table below. Tick **only** these |

   **Scopes (least privilege)** [Certain that scopes exist per area with read/write; Likely on the exact mapping]:

   | Area | Access | Needed for |
   |------|--------|-----------|
   | Organizations | **Read** | Listing the tenant's organisations so they can choose one |
   | Projects | **Read** and **Write** | Creating the tenant's project and checking when it is ready |
   | Database | **Read** | Reading the project's connection-pooler settings |
   | Everything else | none | Not used. Storage will be needed in Wave 1 for tender documents; adding a scope later means tenants approve again |

   If the form has no scope section, it grants full Management API access. Note that and tell me.

5. Confirm / create. Supabase then shows the **Client ID** and **Client Secret**.
6. **Copy both into your password manager immediately.** [Guessing] the secret may be shown only once; if you lose it,
   generate a new one in the same screen and update Part C.
7. Do **not** paste them into chat, email, GitHub, or any file inside the repository.

---

## Part C. Apply the settings to the API

The API reads `apps/api/.env` on start (`pnpm --filter @aerolith/api start`). On the owner PC, keep this file in the
separate Windows user / WSL environment that runs the server (docs/10-deployment.md §10.1).

1. Create `apps/api/.env` from `apps/api/.env.example`.
2. Paste the four secrets printed by `secrets:generate` (`SESSION_SIGNING_KEY`, `LICENCE_KEY_PEPPER`,
   `CONTROL_PLANE_ENC_KEY`, `ENTITLEMENT_PRIVATE_KEY_PEM`).
3. Set these values:

   ```env
   NODE_ENV=production
   PORT=3000
   HOST=127.0.0.1
   CONTROL_DATABASE_URL=<control-plane connection string, your Supabase project>
   PUBLIC_API_URL=https://api.<your-domain>
   WEBSITE_URL=https://<your-domain>
   SUPABASE_API_URL=https://api.supabase.com
   SUPABASE_OAUTH_CLIENT_ID=<from Part B>
   SUPABASE_OAUTH_CLIENT_SECRET=<from Part B>
   TENANT_DB_REGION=ap-south-1
   ```

   `HOST=127.0.0.1` keeps the API off your local network; only the tunnel reaches it.
4. Restrict the file so only the server account can read it (WSL/Linux: `chmod 600 apps/api/.env`).
5. Apply the control-plane migrations, then start:

   ```sh
   pnpm --filter @aerolith/api build
   pnpm --filter @aerolith/api migrate:control
   pnpm --filter @aerolith/api start
   ```

6. Check: `https://api.<your-domain>/api/health` returns `"status":"ok"`, and the start-up log does **not** say
   "Using throwaway secrets". With `NODE_ENV=production` the API refuses to start if any secret is missing.

---

## Part D. Verify end to end with the test tenant account

Run the `curl` commands **on your PC** against `127.0.0.1` (the owner routes are blocked publicly). First sign in to the
owner console (`POST /api/owner/auth/login` with email, password and authenticator code, see
[authentication.md](authentication.md)) and set `$OWNER` to the `accessToken` it returns (valid 15 minutes).

1. **Create a trial tenant** using the second account's email:

   ```sh
   curl -s -X POST http://127.0.0.1:3000/api/owner/tenants \
     -H "Authorization: Bearer $OWNER" -H "Content-Type: application/json" \
     -d '{"email":"test-tenant@example.com","tenantName":"Test Builders"}'
   ```
   Note the `tenantId` from the response.

2. **Create the onboarding link:**

   ```sh
   curl -s -X POST http://127.0.0.1:3000/api/owner/tenants/<tenantId>/onboarding-link -H "Authorization: Bearer $OWNER"
   ```
   The response contains `url` with `?token=...`. Copy the token.

3. **Start the consent.** The website's onboarding page does not exist yet, so open this API address directly in a
   browser where you are signed in to Supabase as the **test** account (a private window is easiest):

   `https://api.<your-domain>/api/onboarding/supabase/authorize?token=<token>`

4. Supabase shows the consent screen for "Aerolith Core". Check the permissions match Part B, then approve.
5. You are sent to `https://<your-domain>/onboarding/status`. The page itself will be missing until the website is built;
   what matters is the address: **no `?error=` in it** means the connection worked.
6. **Check progress:**

   ```sh
   curl -s "https://api.<your-domain>/api/onboarding/status?token=<token>"
   ```
   - `awaiting_org` with a list of organisations: choose one:
     ```sh
     curl -s -X POST https://api.<your-domain>/api/onboarding/supabase/organisation \
       -H "Content-Type: application/json" -d '{"token":"<token>","organisationId":"<id from the list>"}'
     ```
   - `creating`: the project is being made. New Supabase projects usually take a few minutes.

7. **Wait for `ready`:**

   ```sh
   curl -s http://127.0.0.1:3000/api/owner/tenants/<tenantId>/database -H "Authorization: Bearer $OWNER"
   ```
   Expected: `"status":"ready"`, `"schemaVersion"` = the newest file in `apps/api/migrations/tenant/`, `"lastError":null`.

8. In the **test** account's Supabase dashboard you should see a new project named `aerolith-t…` in **South Asia (Mumbai)**,
   with a `platform` schema containing `entity`, `user`, and so on.

### If something fails, send me these (they contain no secrets)

- The `status` and `lastError` from step 7.
- The `?error=` value from the address in step 5, if any.
- The step number where it stopped.

| Symptom | Most likely cause |
|---------|-------------------|
| Supabase says the redirect URI is invalid | `PUBLIC_API_URL` and the registered callback URL differ (Part A2) |
| `?error=consent_denied` | Approval was cancelled on the consent screen |
| `?error=oauth_state_invalid` | The callback page was reloaded, or more than 15 minutes passed. Start again at step 3 |
| `?error=connect_failed` | Wrong client ID/secret, or a missing scope |
| Stuck in `creating` with an error mentioning `organization_slug` or `region_selection` | The Management API payload changed. Send me `lastError` |
| Stuck in `bootstrapping` with a login/authentication error | **[Likely] the most probable first failure:** connecting through Supabase's pooler with our own per-tenant roles. Send me `lastError` |

---

## Part E. Things to know before going commercial

- **Supabase's partner terms.** [Likely] Supabase has an *OAuth Integration Addendum* for partners whose apps manage other
  organisations. Read it before charging customers.
- **Unpublished apps.** [Guessing] Supabase lets you publish OAuth apps to its integrations marketplace (beta). Part D
  proves whether an unpublished app can be authorised by an organisation that isn't yours. If it can't, we apply to publish.
- **Tenants can revoke access** at any time in their own organisation settings. Our stored refresh token then stops
  working (HTTP 401). Their existing database keeps working, because the app connects with its own database roles, but
  new projects or status checks need them to reconnect.
- **Rotating the client secret:** generate a new one in Part B, update `.env`, restart.
- **Never** register `http://` callback URLs for production.

## What changed in the code while preparing this guide

Supabase's documentation shows that `organization_id` and `region` are **deprecated** in the create-project call. The
client now sends `organization_slug` (the organisation "id" Supabase returns is its slug) and
`region_selection: { type: "specific", code: "ap-south-1" }`. [Likely] the `"specific"` type name; it is the first thing
to check if project creation fails.

Sources: [Build a Supabase OAuth integration](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration),
[OAuth scopes](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes),
[Create a project (Management API)](https://supabase.com/docs/reference/api/v1-create-a-project),
[List all organizations](https://supabase.com/docs/reference/api/list-all-organizations),
[Available regions](https://supabase.com/docs/guides/platform/regions),
[OAuth partner addendum](https://supabase.com/legal/partner-resources/program-addenda/oauth-partner-addendum).
