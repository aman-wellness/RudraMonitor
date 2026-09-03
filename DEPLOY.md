# Rudrans — Full deploy from scratch

Zero → running production stack on a **new server**, mirroring the existing
`app.rudrans.com` / `api.rudrans.com` setup on EC2
`18.145.223.204`.

> **Existing prod (do NOT touch when following this guide):**
> - Dashboard: `https://app.rudrans.com` — EC2 `18.145.223.204`
> - API/Supabase: `https://api.rudrans.com` — same box, Kong port 8100
> - TURN: `turn.rudrans.com` — separate box, ports 3478/5349
>
> This guide is for **standing up a NEW customer or region**. Pick a new
> subdomain pair (`app-cx.rudrans.com` + `api-cx.rudrans.com`) or brand-new
> domain, and follow every step.

---

## 0. Copy-pasteable prompt for a fresh Claude session

Paste this into a new Claude Code session to hand off the deploy:

```
You are deploying the Rudrans stack (Rust/Tauri agent + React
dashboard + self-hosted Supabase + coTURN) onto a NEW EC2 instance,
mirroring the existing production at app.rudrans.com /
api.rudrans.com on 18.145.223.204.

Follow /Users/Aman/Desktop/track-force/DEPLOY.md verbatim, phase by
phase. Do NOT deviate from the existing patterns — no Cloud Supabase,
no CORS changes, no destructive git commands.

Target subdomains for this deploy: <NEW-DASHBOARD-DOMAIN> and
<NEW-API-DOMAIN>. Target EC2 IP: <NEW-EC2-IP>. Anon key + service
role key already generated: see SECRETS.local.md → "<CUSTOMER-NAME>"
section (create the section first if missing, using `openssl rand`
values documented in DEPLOY.md Phase 2.3).

Pause after every phase for me to verify. Do NOT proceed to the next
phase without a green ✅ from me. If a step fails, stop and report —
never destructive-recover on your own.
```

---

## 1. Prerequisites the customer must have ready

Before Phase 1 starts, gather:

| Item | Where it comes from | Example |
|---|---|---|
| Domain (or subdomain pair) | Customer's DNS registrar (Route 53, Cloudflare, GoDaddy) | `rudrans.com` |
| Dashboard subdomain | Pick one | `app-cx.rudrans.com` |
| API subdomain | Pick one — must be different, same registrar | `api-cx.rudrans.com` |
| AWS account with permission to spin an EC2 in the region | AWS console | — |
| SSH keypair (`.pem`) | Generated via EC2 console at first launch | `deploy.pem` |
| SMTP creds for password-reset / signup emails | Customer's Google Workspace, Amazon SES, or Postmark | `smtp.gmail.com:587` + app password |
| Razorpay Test + Live keys (if billing is on) | Razorpay dashboard | `rzp_live_…` |
| M365 / Google OAuth app registrations | Customer creates per tenant | Client ID + secret |

Log all values in `SECRETS.local.md` under a new `## <Customer / Region name>`
heading (this file is git-ignored — never commit).

---

## 2. Phase 1 — EC2 provisioning + base OS hardening

**Time: 15 min**

### 2.1. Launch instance

- Region: match the customer's user base (`us-east-1` for USA, `ap-south-1`
  for India, `eu-west-1` for EU).
- AMI: **Ubuntu 24.04 LTS** (existing prod runs 22.04 but 24.04 is the
  supported choice for new deploys — has the security patches out to 2029).
- Instance type: **t3.large** minimum (8 GB RAM). Supabase's Postgres +
  Realtime + Storage + Edge Functions together want ≥6 GB resident.
- Storage: **80 GB gp3** root volume (Postgres + Storage bucket + logs).
- Security group inbound:
  - `22/tcp` from your admin IPs only
  - `80/tcp` from `0.0.0.0/0` (nginx + certbot HTTP challenge)
  - `443/tcp` from `0.0.0.0/0`
- Elastic IP: allocate one and associate. **Never** deploy on the dynamic
  public IP — reboot changes it and DNS breaks.

### 2.2. DNS A-records

Add both subdomains pointing at the Elastic IP:

```
app-cx.rudrans.com          A   <EC2-EIP>   TTL 300
api-cx.rudrans.com      A   <EC2-EIP>   TTL 300
```

Wait until `dig +short app-cx.rudrans.com` returns the EIP before
running certbot in Phase 3.

### 2.3. Base OS

```bash
ssh -i deploy.pem ubuntu@<EC2-EIP>
sudo apt-get update
sudo apt-get -y upgrade
sudo apt-get -y install nginx certbot python3-certbot-nginx \
                        rsync jq curl unzip git build-essential \
                        docker.io docker-compose-v2
sudo usermod -aG docker ubuntu
sudo systemctl enable --now docker
```

Log out + back in so the docker group membership takes effect.

---

## 3. Phase 2 — Self-hosted Supabase stack

**Time: 30 min**

Existing prod uses Supabase's official docker-compose at
`/opt/rudrans/supabase/docker/`. Mirror the same path on the new box so
future runbooks work unchanged.

### 3.1. Clone Supabase compose

```bash
sudo mkdir -p /opt/rudrans
sudo chown ubuntu:ubuntu /opt/rudrans
cd /opt/rudrans
git clone --depth 1 https://github.com/supabase/supabase.git
mv supabase supabase-src
cp -r supabase-src/docker supabase
cd supabase
```

### 3.2. Generate secrets (never reuse prod secrets)

```bash
# In /opt/rudrans/supabase/docker/
cp .env.example .env
# Generate 4 secrets fresh:
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 40)
DASHBOARD_PASSWORD=$(openssl rand -hex 24)
VAULT_ENC_KEY=$(openssl rand -hex 32)

# Derive anon + service_role from JWT_SECRET.
# Use https://supabase.com/docs/guides/self-hosting#api-keys generator OR
# our helper: node scripts/gen-supabase-keys.mjs "$JWT_SECRET"
```

Edit `.env` with values above, plus:
- `SITE_URL=https://app-cx.rudrans.com`
- `API_EXTERNAL_URL=https://api-cx.rudrans.com`
- `SUPABASE_PUBLIC_URL=https://api-cx.rudrans.com`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER_NAME`,
  `SMTP_ADMIN_EMAIL` — customer's SMTP account
- `POSTGRES_PORT=5432` (internal only, do not expose)
- `KONG_HTTP_PORT=8100` — matches existing prod pattern
- `STORAGE_FILE_SIZE_LIMIT=262144000` (250 MB — needed for ffmpeg per-OS
  binaries, agent installers)

**Save every value to `SECRETS.local.md` immediately.** Losing the anon
key later means every agent+dashboard needs a full re-issue.

### 3.3. Bring the stack up

```bash
cd /opt/rudrans/supabase/docker
docker compose pull
docker compose up -d
docker compose ps    # every service should be "healthy" or "running"
```

If Postgres fails first-boot: `docker compose logs db` — usually a stale
volume from a prior test run. `docker compose down -v` (WIPES DATA) then
`up -d` again on a truly fresh box only.

### 3.4. Smoke test Kong

```bash
curl -sI http://localhost:8100 | head -2
# HTTP/1.1 401 Unauthorized  ← Kong is up and refusing unauthenticated
```

---

## 4. Phase 3 — nginx reverse proxy + SSL

**Time: 15 min**

### 4.1. nginx site configs

Two sites: dashboard host and API host.

`/etc/nginx/sites-available/dashboard`:

```nginx
server {
  listen 80;
  server_name app-cx.rudrans.com;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name app-cx.rudrans.com;
  ssl_certificate     /etc/letsencrypt/live/app-cx.rudrans.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app-cx.rudrans.com/privkey.pem;

  root /var/www/rudrans-app;
  index index.html;

  # Outlook Add-in files served with correct MIME
  location /outlook-addin/ {
    alias /var/www/rudrans-app/outlook-addin/;
    default_type application/xml;
    add_header Access-Control-Allow-Origin *;
  }

  # SPA fallback — everything else routes to index.html
  location / { try_files $uri $uri/ /index.html; }
}
```

`/etc/nginx/sites-available/api`:

```nginx
server {
  listen 80;
  server_name api-cx.rudrans.com;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name api-cx.rudrans.com;
  ssl_certificate     /etc/letsencrypt/live/api-cx.rudrans.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api-cx.rudrans.com/privkey.pem;

  client_max_body_size 250M;   # match STORAGE_FILE_SIZE_LIMIT

  location / {
    proxy_pass http://localhost:8100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout  300s;
    proxy_send_timeout  300s;
  }
}
```

Enable + reload:

```bash
sudo ln -sf /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4.2. Certbot — get SSL for both hosts

```bash
sudo mkdir -p /var/www/rudrans-app /var/www/html
sudo certbot --nginx -d app-cx.rudrans.com -d api-cx.rudrans.com \
             -m ops@rudrans.com --agree-tos --non-interactive
# Certbot auto-adds the SSL blocks. If it fails on "already has SSL" —
# ignore, our nginx configs already have the ssl_certificate lines.
```

Auto-renewal timer is enabled by the apt package. Verify:

```bash
systemctl list-timers | grep certbot
```

---

## 5. Phase 4 — Database schema (migrations)

**Time: 30 min**

Existing prod's schema lives at `supabase/migrations/*.sql` in this repo.
Every file must run in order on the new Postgres.

### 5.1. Push migrations

From your dev laptop:

```bash
cd /Users/Aman/Desktop/track-force
# One-shot — cat every migration in order into the new prod DB.
ls supabase/migrations/*.sql | sort | while read f; do
  echo "=== $f ==="
  scp -i deploy.pem "$f" ubuntu@<NEW-EC2-EIP>:/tmp/migration.sql
  ssh -i deploy.pem ubuntu@<NEW-EC2-EIP> \
    "docker exec -i supabase-db psql -U postgres -f /tmp/migration.sql"
done
```

Any failure stops the loop. If a single migration fails: read the error,
fix in the SQL file, re-run just that file, then resume the loop from the
next file.

### 5.2. Seed initial data

```sql
-- Super-admin org for the deploying operator
insert into organizations (id, name, slug, plan)
values (gen_random_uuid(), 'Rudrans Ops', 'we-ops', 'internal');

-- The operator's login email
insert into org_members (org_id, user_id, role, full_name, email)
select id, auth.uid(), 'super_admin', 'Operator Name', 'ops@…'
from organizations where slug = 'we-ops';
```

Run via `docker exec -i supabase-db psql -U postgres` or Studio at
`https://api-cx.rudrans.com/project/default/sql/new`.

---

## 6. Phase 5 — Edge functions

**Time: 20 min**

Every function in `supabase/functions/*/index.ts` needs to live at
`/opt/rudrans/supabase/docker/volumes/functions/<name>/index.ts` and
be registered in `kong.yml`.

### 6.1. Copy every function

```bash
cd /Users/Aman/Desktop/track-force/supabase/functions
for fn in */; do
  fn=${fn%/}
  scp -i deploy.pem -r "$fn" ubuntu@<NEW-EC2-EIP>:/tmp/fn/
  ssh -i deploy.pem ubuntu@<NEW-EC2-EIP> \
    "sudo mkdir -p /opt/rudrans/supabase/docker/volumes/functions/$fn && \
     sudo cp /tmp/fn/$fn/* /opt/rudrans/supabase/docker/volumes/functions/$fn/ && \
     sudo chown -R 1000:1000 /opt/rudrans/supabase/docker/volumes/functions/$fn"
done
```

### 6.2. Register in Kong

`/opt/rudrans/supabase/docker/volumes/api/kong.yml` — add a `routes:` entry
per function following the existing pattern. Compare against the prod file
via `scp` from prod to see the exact shape.

Restart edge runtime + Kong:

```bash
ssh -i deploy.pem ubuntu@<NEW-EC2-EIP> \
  "cd /opt/rudrans/supabase/docker && docker compose restart edge-functions kong"
```

### 6.3. Function env vars

Each function reads its own secrets. Common ones:
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` — M365
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — Google Workspace
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — billing
- `AGENT_TOKEN_HMAC_SECRET` — random 32-byte hex, agent auth

Set in `/opt/rudrans/supabase/docker/.env` under a `# EDGE FUNCTIONS` section
so `docker compose up` re-exports them into the edge container.

---

## 7. Phase 6 — Dashboard build + rsync

**Time: 10 min**

### 7.1. Configure env for the new deploy

`.env.production.local` in the repo (git-ignored):

```
VITE_SUPABASE_URL=https://api-cx.rudrans.com
VITE_SUPABASE_ANON_KEY=<anon-key-from-Phase-2.3>
VITE_SITE_URL=https://app-cx.rudrans.com
```

### 7.2. Build + rsync

```bash
cd /Users/Aman/Desktop/track-force
npm ci           # first-time deploy only
npm run build    # writes out/ + bumps outlook-addin manifest version
rsync -az -e "ssh -i deploy.pem" out/ ubuntu@<NEW-EC2-EIP>:/tmp/rudrans-app-new/
ssh -i deploy.pem ubuntu@<NEW-EC2-EIP> \
  "sudo rsync -a --delete /tmp/rudrans-app-new/ /var/www/rudrans-app/"
```

### 7.3. Verify

```bash
curl -sI https://app-cx.rudrans.com | head -2
# HTTP/1.1 200 OK  ← dashboard is live
```

Open in browser, sign up with the seed super-admin email, walk through
Login → Dashboard shell renders → no console errors.

---

## 8. Phase 7 — coTURN (only if agents will use Remote view)

**Time: 20 min**

For customer-only deploys where agent Remote view is not enabled, skip
this phase. Otherwise:

### 8.1. Provision separate box

- t3.small, own Elastic IP.
- Security group: `3478/udp`, `3478/tcp`, `5349/udp`, `5349/tcp`,
  `49152-65535/udp` (relay range).
- DNS `A`: `turn-cx.rudrans.com` → EIP.
- SSL cert via certbot standalone: `sudo certbot certonly --standalone \
  -d turn-cx.rudrans.com`.

### 8.2. Install + configure

```bash
sudo apt-get install -y coturn
sudo tee /etc/turnserver.conf > /dev/null <<'EOF'
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<32-byte-hex — save to SECRETS.local.md>
realm=turn-cx.rudrans.com
server-name=turn-cx.rudrans.com
external-ip=<EIP>
cert=/etc/letsencrypt/live/turn-cx.rudrans.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn-cx.rudrans.com/privkey.pem
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
min-port=49152
max-port=65535
EOF
sudo systemctl enable --now coturn
```

### 8.3. Wire into dashboard

Update the `turn_relays` table in Postgres:

```sql
insert into turn_relays (region, host, port, secret, enabled)
values ('us-east', 'turn-cx.rudrans.com', 3478, '<same secret>', true);
```

Same static-auth-secret in DB and in `turnserver.conf` — otherwise HMAC
verification fails and clients get "401 relay auth" in the console.

---

## 9. Phase 8 — Agent build + upload to releases bucket

**Time: CI does it — 20 min wall clock, 0 min hands-on**

For a brand-new deploy where you want the customer's own signed builds:

### 9.1. Re-issue Tauri signing key (optional but recommended)

```bash
cd /Users/Aman/Desktop/track-force/agent
npm run tauri signer generate -- -p <passphrase>
# Save the private key to SECRETS.local.md; add public key to
# tauri.conf.json `updater.pubkey` field.
```

### 9.2. Configure updater endpoint in code

`agent/src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://api-cx.rudrans.com/storage/v1/object/public/releases/latest.json"
    ],
    "pubkey": "<from step 9.1>"
  }
}
```

### 9.3. Trigger a release build

```bash
cd /Users/Aman/Desktop/track-force
git tag v0.7.42-<customer-slug>
git push origin v0.7.42-<customer-slug>
# GitHub Actions workflow "build-agent-release.yml" runs on tag push,
# builds Windows MSI/NSIS + macOS pkg + Linux deb, signs them with the
# Tauri key, and uploads to the releases bucket on prod Storage.
```

### 9.4. Customer installer download URL

After CI green:

```
https://api-cx.rudrans.com/storage/v1/object/public/releases/rudrans-agent_<version>_x64_en-US.msi
```

---

## 10. Phase 9 — Marketing pipeline (optional, only if customer buys it)

Existing prod's `generate.py` at `/opt/rudrans-marketing/`. Full details in
`memory/reference_marketing_pipeline.md`. Skip unless the customer's plan
includes weekly marketing posts.

---

## 11. Verification checklist

Before handing over to the customer, all must be ✅:

- [ ] `dig +short app-cx.rudrans.com` resolves to EIP
- [ ] `dig +short api-cx.rudrans.com` resolves to EIP
- [ ] `curl -sI https://app-cx.rudrans.com` → `HTTP/1.1 200 OK`
- [ ] `curl -sI https://api-cx.rudrans.com` → Kong header present
- [ ] `curl -s https://api-cx.rudrans.com/rest/v1/` → 200 with anon key
- [ ] SSL Labs A+ on both hosts: https://www.ssllabs.com/ssltest/
- [ ] `docker compose ps` inside `/opt/rudrans/supabase/docker/` — every
      service healthy
- [ ] `nginx -t` clean
- [ ] Sign-up + login round-trip through the dashboard works
- [ ] `agent_inventory` table exists and accepts a POST via
      `agent-inventory-post` edge function
- [ ] Certbot renewal timer: `systemctl list-timers | grep certbot`
      shows a next-run within 60 days
- [ ] Storage upload test: `curl -X POST … /storage/v1/object/…` → 200
- [ ] Signature push end-to-end (dashboard → Exchange Online Store) —
      only if M365 tenant is set up
- [ ] Agent install on a test Windows box, appears in dashboard within
      2 minutes of first launch
- [ ] Agent Remote view works (if coTURN is deployed)

---

## 12. Common gotchas

Curated from actual incidents on the current prod:

1. **`.supabase.co` in `.env` is stale/dev.** New deploys must use the
   self-hosted `api-cx.rudrans.com` (or the customer's own API subdomain).
   See `memory/reference_supabase_db.md`.
2. **Nginx SPA fallback serves index.html for missing files.** Manifest
   files, sitemaps, and any static XML/text need explicit `location`
   blocks with `alias` — otherwise Microsoft admin center rejects
   `manifest.xml` because it received HTML with 200. See DEPLOY §4.1.
3. **Storage `POST` returns 303 See Other** — that's success, not
   failure. `curl -w '%{http_code}'` will say 303; use `-L` to follow
   or trust the JSON body.
4. **Kong port varies:** existing prod maps host `8100 → container 8000`.
   New deploys should use the same 8100 externally so runbooks work.
5. **Never assume Cloud Supabase from `.env` alone.** Always
   `curl -I https://<api-host>` and confirm `Server: kong` before
   answering "is this hosted where I think".
6. **Media retention is 30 days**, purged by `rudrans-purge.timer` —
   copy the timer + service files from prod when you deploy this,
   otherwise Storage bloats indefinitely.
7. **`super_admin` RLS pitfall:** every dashboard page that queries
   `organizations` must do `.eq('id', orgId)` derived from `useAuth`.
   A bare `.limit(1)` silently breaks for super-admins who see multiple
   orgs. See `memory/feedback_super_admin_rls_limit_pitfall.md`.
8. **Never touch prod CORS without a staging window.** See
   `memory/feedback_no_cors_change_in_prod.md`.
9. **Outlook Add-in manifest `<Version>` must bump on every deploy** —
   `npm run build` auto-bumps via `scripts/bump-addin-version.mjs`.
   If a manifest is uploaded with an unchanged version, Microsoft admin
   center's Update flow refuses with "Please update the version number".
10. **Agent auto-updater is already wired.** Do not build a new updater
    path. Just bump `Cargo.toml` + `tauri.conf.json` version + push a
    `v*` git tag. See `memory/reference_agent_autoupdate.md`.

---

## 13. Rollback

If a Phase fails past recovery on a fresh box, the safest rollback is:

- Phase 1 — terminate the EC2, release the EIP, re-run.
- Phase 2 — `docker compose down -v` (wipes Postgres volume), restart Phase 2.
- Phase 3 — `sudo rm /etc/nginx/sites-enabled/{dashboard,api}` +
  `sudo certbot delete --cert-name app-cx.rudrans.com` + retry.
- Phase 4 onward — never destructive-rollback; fix the failing migration
  or function file, re-run only that piece.

**Never rollback the existing prod (`18.145.223.204`) while trying to
recover a new deploy.** They share DNS root but nothing else.

---

## 14. Handover to customer

Once verification is clean:

1. Send customer:
   - Dashboard URL: `https://app-cx.rudrans.com`
   - Login: super-admin credentials seeded in Phase 5.2
   - Agent installer URL from Phase 9.4
   - Docs: `https://app-cx.rudrans.com/docs/user-guide`
2. Add the new box to the on-call runbook (`SECURITY-OPS.md`) so
   `certbot`, `docker`, and disk-space alerts get watched.
3. Schedule the 30-day media purge timer.
4. Move `SECRETS.local.md` `<Customer name>` section into the shared
   Vault (1Password / Bitwarden Enterprise) — never leave it only on
   your laptop.
