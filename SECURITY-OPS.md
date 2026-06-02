# Security Operations Runbook — Post-Audit Hardening (2026-06-02)

This file tracks the **out-of-band** security fixes — the things that cannot be patched purely in application code. Each item maps to a finding from the audit; tick the box once the operations team has executed it and verified it.

## 1. SECRET ROTATION (Critical — within 24 hours)

The committed `.env.production` exposed three live secrets. **All must be rotated even if the git history is purged**, because the file was reachable to anyone who cloned the repo while the commit was on `main`.

- [ ] **Microsoft OAuth Client Secret** (`MICROSOFT_OAUTH_CLIENT_SECRET`)
  - Portal → Azure → App registrations → Rudrans → Certificates & secrets → New client secret
  - Revoke the old secret in the same screen
  - Update `MICROSOFT_OAUTH_CLIENT_SECRET` in the Supabase Edge Functions vault and any EC2 env
- [ ] **Google OAuth Client Secret** (`GOOGLE_OAUTH_CLIENT_SECRET`)
  - Portal → Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Reset secret
  - Update server env in the same locations
- [ ] **Supabase anon JWT** — the leaked JWT carries `exp: 2093` which is effectively forever.
  - SSH to api.rudrans.com → regenerate Supabase JWT secret in `.env` → `docker compose restart` Kong+Auth+Postgrest
  - Re-issue `anon` and `service_role` JWTs with a **realistic expiry** (12 months max)
  - Redeploy the frontend (`out/` to nginx) with the new anon key baked into the Vite bundle

After rotation, run `git filter-repo --invert-paths --path .env.production` and force-push `main`. Add gitleaks pre-commit hook so this cannot recur.

## 2. NGINX CONFIGURATION (High — within 7 days)

`app.rudrans.com` and `api.rudrans.com` both run on the same EC2 box (`54.241.176.28`). Edit `/etc/nginx/sites-enabled/app.rudrans.com` and `…/api.rudrans.com`.

- [ ] **Remove `unsafe-inline` and `unsafe-eval` from the CSP** on `app.rudrans.com`
  - Build the frontend with `vite build --mode production` and adopt nonce-based CSP via the `crypto.randomUUID()` injected at request time, or migrate to hash-based CSP for the inline bootstrap script.
- [ ] **Drop the stale Supabase Cloud project URL** from CSP `connect-src` — remove `https://ttjazaxjhzvrzhptrpmd.supabase.co` and `wss://ttjazaxjhzvrzhptrpmd.supabase.co`. Production only uses `api.rudrans.com`.
- [ ] **Hide server identity**: add `server_tokens off;` in the `http {}` block of `/etc/nginx/nginx.conf`. Restart nginx.
- [ ] **Hide Kong's identity**: in `/etc/kong/kong.yml` (or wherever the declarative config lives) set `headers = off` and `headers.server_tokens = off`. Restart Kong.

## 3. DNS RECORDS (Medium — within 7 days)

Run from your DNS host (likely Route53 or wherever the Outlook MX is managed).

- [ ] Publish a DMARC policy:
  ```
  _dmarc.rudrans.com.   TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@rudrans.com; ruf=mailto:dmarc@rudrans.com; adkim=s; aspf=s"
  ```
- [ ] Publish a CAA record so only your chosen CA can issue certs:
  ```
  rudrans.com.   CAA   0 issue "letsencrypt.org"
  rudrans.com.   CAA   0 issuewild "letsencrypt.org"
  rudrans.com.   CAA   0 iodef "mailto:security@rudrans.com"
  ```

## 4. TAURI AUTO-UPDATE SIGNING (Critical — within 24 hours)

The agent's updater endpoint (`https://api.rudrans.com/storage/v1/object/public/releases/latest.json`) lives in a *public* Supabase Storage bucket. Anyone who compromises that bucket (e.g., service-role key leak) can ship a trojaned update to every installed agent.

- [ ] Generate the Tauri signing key on an offline machine: `cargo tauri signer generate -w ~/.tauri/rudrans.key`.
- [ ] Store the private key in a hardware token / 1Password Business; only release into CI signing job under MFA.
- [ ] Verify the `pubkey` field in `agent/src-tauri/tauri.conf.json` matches the key fingerprint.
- [ ] Switch `releases` bucket from `public` to `private` and have the Tauri updater fetch through a signed-URL Edge Function that verifies caller identity (org enrollment).
- [ ] CI: `cargo tauri build` → produces `latest.json` already containing the signature; upload only signed artifacts.

## 5. SUPABASE AUTH POLICIES (Medium — within 7 days)

Login to Supabase Studio (self-hosted, behind Kong basic-auth) → Auth → Policies.

- [ ] **Password policy**: set minimum 10 chars, require uppercase + digit + symbol.
- [ ] **Rate limiting**: enable per-IP rate limits on `/auth/v1/recover`, `/auth/v1/signup`, `/auth/v1/token`.
- [ ] **Session expiry**: shorten access-token TTL to 1 hour, refresh-token to 30 days.
- [ ] **Email enumeration**: enable "Disclose login status" = off (so failed login returns identical message regardless of email existing).

## 6. STORAGE BUCKET RLS (Medium — within 30 days)

`psql` into the self-hosted Postgres on api.rudrans.com and verify each bucket:

```sql
SELECT id, name, public, file_size_limit
FROM storage.buckets;

SELECT name, definition FROM pg_policies WHERE schemaname = 'storage';
```

- [ ] Buckets that hold PII (`screenshots`, `videos`, `credential-invoices`) MUST be `public = false` AND have RLS policies that join through `agents` / `invoice_fetch_jobs` to `org_members` for SELECT.
- [ ] `releases` bucket: see §4 — move to private.
- [ ] `marketing-app-screens`: can remain public (marketing assets only). Verify no PII has been accidentally uploaded.

## 7. CI / SUPPLY-CHAIN GATES (Low — within 30 days)

- [ ] Commit `package-lock.json` (currently absent).
- [ ] Add `gitleaks` pre-commit + GitHub Action — block any commit containing `eyJhb`, `xoxb-`, `GOCSPX-`, AWS keys, etc.
- [ ] Add `npm audit --omit=dev --audit-level=high` to CI; fail on high+.
- [ ] Add `cargo audit` to the agent build pipeline.

## 8. INCIDENT-RESPONSE PREP (Low — within 90 days)

- [ ] Document a 1-pager IR playbook in `docs/security/IR.md`: who to call, how to revoke Supabase service_role key, how to push a Tauri kill-switch update.
- [ ] Enable Postgres audit logging (`pgaudit`) for `auth.users`, `app_users`, `org_members`.
- [ ] Set up a Grafana panel for: failed-auth rate, OTP attempt rate, Razorpay webhook-signature failures, edge-function 5xx rate. Alert on 3σ spikes.

---

**Code-side fixes already applied (this commit):** see `git show HEAD` after committing — `supabase/functions/_shared/cors.ts` (origin allowlist), `razorpay-webhook` (timing-safe + amount re-verification + plan is_active), `m365-webhook` (clientState bypass closed), `employee-save` (authz before insert), `upload-video` + `invoice-job-complete` (magic-byte validation), `verify-phone-otp` + `invoice-otp-submit` (DB-backed brute-force limiter), `razorpay-verify-upgrade` (subId/payId/sig format guards), `agent/src-tauri/tauri.conf.json` (strict CSP), `scripts/marketing/generate.py` (ffmpeg textfile + redacted key log), and migration `0110_security_hardening.sql` (closes `billing_entity` read-all, adds rate-limit table + RPC, deduplicates invoice numbers).
