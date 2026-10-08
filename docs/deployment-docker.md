# Running Aerolith Core with Docker Compose (owner PC, later a VM)

Wave 0 step 7. One command starts the whole server side: Postgres, the API (with the email and provisioning workers)
and Caddy serving the browser app. The same files run unchanged on a VM later (docs/10-deployment.md §10.1).

Tags: [Certain] tested here or confirmed in the vendor's terms; [Likely] strong inference; [Guessing] check yourself.

## 1. What runs

```
                    this PC only (127.0.0.1)
 tunnel / browser ──► :8080  Caddy (web) ── /api/*  ──► api:3000 ──► postgres:5432
                              └─ SPA files            (NestJS,       (not published)
 your browser/curl ─► :8081  Caddy (owner listener)    workers)
                              └─ /api/owner*, /api/auth/mfa/*, /api/health only
```

| Service | Image | Notes |
|---------|-------|-------|
| `postgres` | `postgres:16-alpine` | Control plane (`aerolith_control`) and, in stage 0, stand-in tenant databases. No published port |
| `api` | `deploy/api.Dockerfile` (Node 22, non-root) | Applies control-plane migrations on every start, then serves the API. ~380 MB |
| `web` | `deploy/web.Dockerfile` (Caddy 2) | The browser app plus the reverse proxy. ~95 MB |

[Certain] Port rules, checked in CI on every push (`docker-stack` job):

- `:8080` is the public site. Any `/api/owner*` request gets **404** there, so the owner console never reaches the internet even if the tunnel publishes the whole site.
- `:8081` is the owner listener. Docker publishes it on `127.0.0.1` only, whatever `BIND_ADDRESS` says. It serves only owner routes, operator MFA and health; anything else gets 404.
- `BIND_ADDRESS` defaults to `127.0.0.1` for `:8080` too. Only a tunnel running on the same machine can reach it.

All software here is free with permissive or copyleft licences that allow commercial use without fees (Docker Engine
Apache-2.0, Caddy Apache-2.0, PostgreSQL licence, Node MIT). Nothing is redistributed to tenants.

## 2. One-time setup on Windows

**Use Docker Engine inside WSL2, not Docker Desktop.**
- [Certain] Docker Desktop is free only for personal use, education, non-commercial open source and businesses under 250 employees **and** under US$10 million revenue. Above that it needs a paid subscription.
- You probably qualify today. Docker Engine has no such condition, so nothing changes as the company grows (docs/licensing-policy.md).

1. **Server account.** Create a separate standard (non-admin) Windows user, e.g. `aerolith-server`. Do every following step signed in as that user.
   - [Certain] WSL distributions are per Windows user, so your daily account cannot see the server's files or `.env`.
2. **Disk encryption.** Turn on BitLocker or "Device encryption".
   - [Likely] Windows Home has only Device encryption, and only on supported hardware. Check Settings → Privacy & security.
3. **WSL2 + Ubuntu.** In an admin PowerShell, run `wsl --install -d Ubuntu-24.04`, reboot, then create the Linux user when asked.
4. **Enable systemd** so Docker starts with the distribution. In Ubuntu, run:
   ```sh
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```
   Then run `wsl --shutdown` in PowerShell and open Ubuntu again.
5. **Docker Engine + Compose plugin:** follow docs.docker.com → *Install Docker Engine on Ubuntu* (the `apt` repository method), then:
   ```sh
   sudo usermod -aG docker $USER   # log out and back in
   docker run --rm hello-world
   ```
6. **Get the code** inside the Linux file system, not under `/mnt/c`, which is slow and readable from Windows:
   ```sh
   git clone https://github.com/<you>/<repo>.git ~/aerolith && cd ~/aerolith
   ```

## 3. First start

```sh
bash deploy/scripts/init-env.sh        # creates deploy/.env with fresh secrets (chmod 600); refuses to overwrite
nano deploy/.env                       # review URLs and email settings (section 5)
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps        # api "healthy", web "running"
curl http://127.0.0.1:8080/api/health                 # {"status":"ok",...}
```

Open `http://127.0.0.1:8080` in a Windows browser. [Likely] WSL2 forwards `127.0.0.1` to Windows by default.

**Make the encrypted offline copy of `deploy/.env` now.** It holds `CONTROL_PLANE_ENC_KEY`.
- Losing that key makes every stored tenant credential and licence-key copy unreadable.
- Every tenant's database credential would then have to be re-issued (docs/10-deployment.md §10.1).

Example: `gpg -c deploy/.env` produces `deploy/.env.gpg`. Copy it to a USB drive kept offline, and store the passphrase in your password manager. Never commit `deploy/.env`; `.gitignore` already excludes it.

**Create your owner-console account** (single owner, MFA mandatory):

```sh
docker compose -f deploy/docker-compose.yml exec api node dist/cli/create-operator.js --email you@<your-domain> --name "Your Name"
```

It prints a one-time password. Sign in against the owner listener, `http://127.0.0.1:8081/api/owner/auth/login`, then enrol your authenticator and change the password as described in [authentication.md](authentication.md). The owner-console screens come later; until then use `curl` from this PC.

## 4. Everyday commands

All commands use `docker compose -f deploy/docker-compose.yml` (shortened to `dc` below).

| Task | Command |
|------|---------|
| Status / logs | `dc ps` · `dc logs -f api` |
| Stop / start | `dc stop` · `dc up -d` |
| Update to new code | `git pull && dc up -d --build`. Control-plane migrations run on API start; tenant databases follow through the owner endpoint `POST /api/owner/migrations/rollout` |
| Read file-transport emails | `dc cp api:/app/.mail-outbox ./mail` |
| Back up the control plane | `dc exec -T postgres pg_dump -U aerolith -Fc aerolith_control > control-$(date +%F).dump`. Tenant credentials in it stay encrypted; the dump is useless without `deploy/.env` |
| Remove everything **including data** | `dc down -v` (asks nothing; only for test machines) |

**Auto-start.**
- `restart: unless-stopped` brings the containers back whenever Docker starts.
- [Guessing] WSL stops a distribution shortly after its last Windows-side process exits. To keep it running after a reboot, add a Task Scheduler task:
  - Trigger: *At startup*.
  - Run as: `aerolith-server`, with *Run whether user is logged on or not*.
  - Action: `wsl.exe -d Ubuntu-24.04 -u root -- sleep infinity`.
- Verify it by rebooting without signing in, then checking `/api/health` through the tunnel.
- Also turn off sleep in Windows power settings.

## 5. Settings that matter in `deploy/.env`

| Setting | Stage 0 value |
|---------|---------------|
| `PUBLIC_API_URL` | The public `https://` origin the tunnel gives you; `http://127.0.0.1:8080` while testing locally. Supabase's OAuth callback is built from it, so it must match the registered callback exactly ([supabase-oauth-setup.md](supabase-oauth-setup.md) A2) |
| `WEBSITE_URL` | **The address that serves the browser app.** In this stack that is the same origin as `PUBLIC_API_URL`. Emailed links (`/account/set-password`, `/account/reset-password`) open there. It is *not* the Vercel marketing site, which does not host these pages |
| `CORS_ORIGINS` | `app://aerolith` (the desktop app). The browser app is same-origin and needs no entry |
| `EMAIL_TRANSPORT` | `file` until SMTP is set up, then `smtp` with the GoDaddy/Microsoft 365 values from [email.md](email.md) |
| `CONTROL_DATABASE_URL` | Unset = the local Postgres container. Point it at your own Supabase project's pooler to take the control plane off the PC (§10.1 "Disk failure") |
| `LOCAL_PG_ADMIN_URL` | Unset = stand-in tenant databases on the local Postgres (testing). Set it to an empty value to disable them once real tenants use Supabase |
| `BIND_ADDRESS` | Keep `127.0.0.1`. Use `0.0.0.0` only on a VM behind its own firewall |

An empty value (`SMTP_HOST=`) counts as "not set", so unused lines from the example file are harmless.

## 6. Making it reachable from the internet (without Cloudflare)

[Certain] You need a public **HTTPS** address for three things:
- tenants using the browser app;
- the desktop app's `apiBaseUrl`;
- Supabase sending the browser back after OAuth consent.

The address must forward to `127.0.0.1:8080`, **never** `:8081`.

| Option | Custom domain (`app.<your-domain>`) | Cost / terms | Fit |
|--------|-------------------------------------|--------------|-----|
| **Free VM** (e.g. an always-free ARM instance in Mumbai/Hyderabad) running this same stack, with a GoDaddy DNS `A` record and Caddy's automatic HTTPS | Yes | ₹0. [Guessing] Free-tier accounts can be reclaimed; read the terms | **Best for real tenants.** No home connection exposed, no CGNAT problem, the master key leaves your daily PC |
| **Tailscale Funnel** (open-source Linux client inside WSL) | [Likely] No: you get `https://<machine>.<tailnet>.ts.net` | Free plan. [Likely] It is meant for personal use; check the terms before tenants depend on it | Good for **testing**, e.g. the Supabase OAuth check |
| **ngrok** (free plan) | No: one random or static `*.ngrok-free.app` address | [Likely] The free plan shows a warning page before browser traffic, which breaks the first-visit experience and can break the OAuth redirect. The agent is closed-source | Testing only, and the weakest option |
| **Port forwarding + dynamic DNS** | Yes | Free | [Likely] Often impossible on Indian ISPs (CGNAT). It also breaks the §10.1 rule "no inbound ports". Not recommended |
| Cloudflare Tunnel | Yes, but [Likely] only if the domain's DNS moves to Cloudflare | Free | You chose not to use Cloudflare |

**Recommendation.** The app goes public only after v1, so no tunnel is needed today.
- **For the deferred Supabase OAuth test:** use Tailscale Funnel's `ts.net` address as `PUBLIC_API_URL`/`WEBSITE_URL` and as the registered callback, for a few hours.
- **For real tenants:** go straight to the VM (stage 1) with `app.<your-domain>`.
  - The custom domain matters: Supabase's registered callback URL and every emailed link contain the hostname.
  - Changing the hostname later means re-registering the callback, and old emails would point to a dead address.

Example: Tailscale Funnel inside WSL, for the OAuth test only.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                       # sign in once in the browser it opens
sudo tailscale funnel --bg 8080         # https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8080
sudo tailscale funnel status
sudo tailscale funnel --https=443 off   # when finished
```

[Guessing] Flag names change between Tailscale versions. If these fail, check `tailscale funnel --help`.

After changing `PUBLIC_API_URL` or `WEBSITE_URL`, restart the API: `dc up -d api`.

**Stage 1 (VM) differences**, to be done when moving:
- Add a Caddy site block for `app.<your-domain>`. Caddy obtains and renews the certificate itself.
- Open only ports 80 and 443 in the VM firewall.
- Keep `:8081` on `127.0.0.1` and reach it over SSH: `ssh -L 8081:127.0.0.1:8081 vm`.

## 7. Stage 0 rules (docs/10-deployment.md §10.1, restated)

- No inbound ports on the home router.
- Separate Windows user, disk encryption, `deploy/.env` readable only by the server user.
- Nothing else runs in the server's WSL distribution.
- Tell trial tenants it is a beta that can go down when the PC is off.
- Move to a VM before the first tenant you don't personally know signs up, or at the first outage a tenant notices.

## 8. Testing the stack

CI job `docker-stack` (`.github/workflows/ci.yml`) does the following on every push:
1. Builds both images and generates a throwaway `deploy/.env`.
2. Starts the stack with `deploy/docker-compose.e2e.yml`, which writes emails to a host folder.
3. Checks the port rules in §1.
4. Runs the browser end-to-end journey through Caddy.

To run the same journey locally:

```sh
mkdir -p /tmp/aerolith-mail && chmod 777 /tmp/aerolith-mail
E2E_MAIL_DIR=/tmp/aerolith-mail docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml up -d --build --wait
cd tests/e2e
E2E_BASE_URL=http://127.0.0.1:8080 E2E_OWNER_URL=http://127.0.0.1:8081 E2E_MAIL_DIR=/tmp/aerolith-mail \
E2E_OPERATOR_CMD="docker compose -f deploy/docker-compose.yml exec -T api node dist/cli/create-operator.js" \
E2E_OPERATOR_CWD="$(git rev-parse --show-toplevel)" pnpm e2e
```

Run this only against a test stack. It creates an operator and a tenant in whatever database the stack uses.

Building behind a TLS-inspecting proxy (corporate networks): pass its CA certificate and proxy to the build:

```sh
docker build --network host --secret id=extra_ca,src=<ca.pem> --build-arg HTTPS_PROXY=$HTTPS_PROXY ...
```
