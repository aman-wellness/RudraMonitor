# TrackForce — Enterprise Security Assessment

**Classification:** Confidential — Internal / Executive
**Engagement type:** Authorized white-box security assessment (source + configuration review)
**Target:** TrackForce employee-monitoring platform (web dashboard, edge backend, desktop agent, mobile app, cloud infra, payments)
**Method:** Static source-code & configuration review (read-only). No active exploitation against production was performed.
**Standards referenced:** OWASP Top 10 (2021), OWASP API Top 10 (2023), OWASP MASVS, OWASP ASVS, PCI-DSS v4.0, SOC 2, ISO 27001, NIST CSF, CIS Benchmarks.
**Date:** 2026-06-02

> **Scope note / honesty caveat.** This report is built from a thorough *static* review of the codebase, SQL migrations, edge functions, Tauri/Capacitor config, and infra files. Findings marked **[needs runtime confirmation]** require a live, controlled test (in a staging org, not production) to confirm exploitability. Several Critical/High findings are confirmable from code alone and should be treated as live.

---

## 1. Executive Summary

TrackForce is a broad, genuinely production-grade platform: a React 19 SPA, ~90 Supabase edge functions, 108 SQL migrations with row-level security (RLS), a Tauri/Rust desktop agent with remote-desktop (RustDesk) and screen capture, a Capacitor mobile app, Razorpay billing, and self-hosted infra on EC2 (RustDesk + LiveKit/coturn).

**The engineering quality is above average for a product at this stage** — privileged edge functions re-verify JWTs internally, storage buckets for screenshots/videos are correctly private and org-scoped, OAuth uses PKCE and `state` CSRF protection, there are no XSS sinks in the frontend, and no live secret is committed to git. These are real strengths and should be credited.

**However, the assessment identified systemic weaknesses that block enterprise/production sign-off in three areas:**

1. **Payments** — the Razorpay webhook activates paid plans and add-ons from client-controllable `notes` on the *mandate-authentication* event (not a real charge), with no amount verification and no replay/idempotency protection. Paid access can be obtained for the ₹2 verification fee, and licenses can be extended indefinitely by replaying one signed webhook.
2. **Remote desktop / endpoint control** — the RustDesk unlock password is derived from the session token and truncated to **32 bits**, sessions can be **auto-approved with no employee consent** based on a client-trusted boolean, and the token that determines the password is logged and broadcast.
3. **Data-layer authorization** — the `credentials` (password vault) RLS lets *any* org member read encrypted secrets and write/delete vault entries, and multiple `SECURITY DEFINER` functions (including the role-assignment trigger and `is_super_admin()`) lack `SET search_path`, opening a privilege-escalation path.

**Verdict:** Not yet enterprise-ready or approved for continued unrestricted production use without remediating the Critical findings. None are architectural dead-ends — all are fixable within the roadmap below.

---

## 2. Security Score

| | |
|---|---|
| **Overall security posture** | **52 / 100** |

Component breakdown:

| Domain | Score | Rationale |
|---|---:|---|
| Web application | 78 | No XSS sinks, good redirect/CSRF hygiene; relies on server-side RLS (mostly sound) |
| API / edge functions | 60 | Strong JWT re-checks, but `verify_jwt=false` pattern fragile; in-memory rate limiting |
| Payments | 35 | Webhook trusts client notes; no amount check; no idempotency |
| Database / RLS | 48 | credentials RLS open; missing search_path on definer fns; unmanaged OTP tables |
| Mobile | 55 | Token in localStorage, allowBackup, debuggable debug variant, custom-scheme deep link |
| Desktop agent | 40 | 32-bit derived RDP password, no-consent auto-approve, CSP disabled, plaintext token |
| Cloud / infra | 55 | Public binary buckets (supply chain), host-net RustDesk, ENCRYPTED_ONLY not set |
| CI/CD | 65 | Good secret masking; unpinned action; unverified binary downloads |
| Data protection / privacy | 50 | Screenshots retained past log purge; thin audit trail; cascade-delete default-on |

---

## 3. Risk Matrix

| ID | Finding | Likelihood | Impact | Severity |
|---|---|---|---|---|
| PAY-1 | Webhook activates plans/add-ons from client `notes` on auth event | High | High | **Critical** |
| RDP-1 | RustDesk password = 32-bit hash of session token | High | Critical | **Critical** |
| DB-1 | `credentials` RLS — any member reads/writes the vault | High | High | **Critical** |
| DB-2 | SECURITY DEFINER fns without `search_path` (role trigger, is_super_admin) | Medium | Critical | **High** |
| RDP-2 | Remote session auto-approve with no consent (client-trusted bool) | High | High | **High** |
| RDP-3 | Session token + RDP password logged/broadcast | Medium | High | **High** |
| PAY-2 | No webhook idempotency → replay double-extends license | High | Medium | **High** |
| PAY-3 | Access granted on ₹2 verification, no plan-charge confirmation | High | Medium | **High** |
| PAY-4 | No amount verification; seats/currency client-influenced | Medium | Medium | **High** |
| DB-3 | `otp_codes`/`contact_verifications` have no migration / likely no RLS | Medium | High | **High** |
| INF-1 | Public `rustdesk`/`ffmpeg` buckets → unverified binaries in signed build | Low | Critical | **High** |
| INF-2 | RustDesk permanent password + host-net + ENCRYPTED_ONLY not set in YAML | Medium | High | **High** |
| MOB-1 | Session token in WebView localStorage (+ allowBackup, debuggable debug) | Medium | High | **High** |
| API-1 | enroll_token = long-lived plaintext bearer (media + ingest) | Medium | Medium | Medium |
| DB-4 | Weak OTP entropy (`Math.random`) + unsalted SHA-256 | Medium | Medium | Medium |
| INF-3 | TURN creds SHA-1, no owner binding, TURNS disabled | Low | Medium | Medium |
| WEB-1 | Wildcard CORS on sensitive functions | Low | Low | Low |
| PRIV-1 | Screenshots retained past log purge; no immutable audit log | Medium | Medium | Medium |
| AGT-1 | Desktop enroll_token + license stored plaintext on disk | Medium | Medium | Medium |
| MAC-1 | macOS `disable-library-validation`, no sandbox | Low | Medium | Medium |

---

## 4. Attack Surface

```
                          ┌──────────────────────────────────────────┐
   Employee endpoints     │            Internet / Public              │
   (Win/mac/Linux agent)  │                                           │
        │  screen/video/   │   app.rudrans.com (SPA, Vercel/static)    │
        │  DLP/remote      │        │  anon key (public, OK)           │
        ▼                  │        ▼                                  │
   ┌──────────┐   enroll   │   ┌────────────────────────────────┐     │
   │  Agent   │──token────▶│   │  Supabase self-host             │     │
   │ (Tauri)  │  (bearer,  │   │  api.rudrans.com                │     │
   │ RustDesk │  plaintext)│   │  • 90 edge fns (JWT re-checks)  │     │
   └────┬─────┘            │   │  • Postgres + RLS               │◀─── Razorpay webhook
        │ realtime         │   │  • Storage (screens/vids priv,  │     (notes-trusted ⚠ PAY-1)
        │ remote.request   │   │    rustdesk/ffmpeg PUBLIC ⚠)    │     │
        │ (auto_approved ⚠)│   └────────────────────────────────┘     │
        ▼                  │        │                                  │
   ┌──────────┐            │        ▼                                  │
   │ RustDesk │ host-net   │   EC2: hbbs/hbbr 21115-21117,             │
   │  EC2     │ public IP  │   LiveKit, coturn (SHA-1 TURN)           │
   └──────────┘            └──────────────────────────────────────────┘
   Mobile (Capacitor): token in localStorage, custom-scheme OAuth deep link
```

**Trust boundaries crossing untrusted input:** Razorpay webhook → DB (PAY-1); Realtime `remote.request` → agent control (RDP-2); monitored URLs/app names → dashboard render (escaped, OK); public buckets → signed build (INF-1).

---

## 5. Vulnerability Findings

### PAY-1 — Webhook activates paid plans/add-ons from client-controllable `notes` *(Critical)*
- **CVSS 3.1:** 9.1 (AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:H/A:H) — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:H/A:H`
- **Evidence:** `supabase/functions/razorpay-webhook/index.ts:70-91` reads `org_id`, `plan_code`, `seats` from `sub.notes` and calls `swap_org_plan` / `activate_org_addon` / `swap_trial_plan` on `subscription.authenticated` (the ₹2 mandate event, not a plan charge). No check that `notes.org_id` owns the subscription; no amount validation. RPCs are SECURITY DEFINER with no payment check (`0096_upgrade_rpcs.sql:11-73`, `0099_addon_seats_and_assignments.sql:19-85`). The synchronous sibling `razorpay-verify-upgrade/index.ts:71-101` *does* re-verify ownership — the webhook skips it.
- **Impact:** Arbitrary org flipped to `active` on any plan/seat count for the ₹2 verification fee, or via a forged/replayed event.
- **Reproduction [needs runtime confirmation in staging]:** Deliver a `subscription.authenticated` webhook (valid signature) with crafted `notes.org_id`/`plan_code`/`seats`; observe target org activated.
- **Remediation:** Re-fetch the subscription from Razorpay by `sub.id`, read `notes` from the API truth, verify the org's stored `razorpay_subscription_id` matches, gate activation on a real `subscription.charged` whose amount equals server-computed `plan.price × seats`.

### RDP-1 — RustDesk unlock password derived from session token, truncated to 32 bits *(Critical)*
- **CVSS 3.1:** 9.6 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`
- **Evidence:** `agent/src-tauri/src/remote/rustdesk_host.rs:295-299` — `derive_pass()` = `hex(sha256(token)[..4])` → 8 hex chars / 32 bits, set as the **permanent** password (`use-permanent-password`, `:139`) with keyboard/clipboard/file-transfer enabled (`:141-143`).
- **Impact:** Full remote control of the employee endpoint. Password is a pure function of the session token (which leaks — see RDP-3) and the keyspace is brute-forceable.
- **Remediation:** Generate ≥128-bit CSPRNG password per session, never derived from the token; rotate per session.

### DB-1 — `credentials` vault RLS allows any org member to read/write secrets *(Critical)*
- **CVSS 3.1:** 8.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`
- **Evidence:** `supabase/migrations/0028_credentials.sql:132-139` — `credentials_select`/`credentials_write` gate only on `org_id in (select user_org_ids())`, which includes **any** member, not just admins. The "block reads at the app layer" comment is not enforced; a member can `select password_enc` directly, and `for all` allows INSERT/UPDATE/DELETE.
- **Impact:** Any low-privilege employee reads/exfiltrates or tampers with the org credential vault.
- **Remediation:** Revoke table SELECT from `authenticated`; force reads through a column-restricted view; gate writes to org admin/owner.

### DB-2 — SECURITY DEFINER functions without `SET search_path` *(High)*
- **CVSS 3.1:** 8.8 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`
- **Evidence:** `0013_partners_billing.sql:24` `handle_new_user_role()` (runs on every `auth.users` insert, assigns role), `:227` `is_super_admin()`, others. Mutable search_path lets an attacker who can create objects shadow referenced tables/functions in a definer context → grant self `super_admin`.
- **Remediation:** Add `SET search_path = pg_catalog, public` (or `= ''` + fully-qualified names) to all definer functions; prioritize the auth trigger and role-check primitives.

### RDP-2 — Remote session auto-approved with no consent *(High)*
- **CVSS 3.1:** 8.6 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N`
- **Evidence:** `agent/src-tauri/src/remote/realtime_listener.rs:227-228,260-267` — `auto_approved` comes from the inbound broadcast; `if req.auto_approved { true } else { consent::show_prompt(...) }`. A `remote.request` with `auto_approved:true` starts control with no prompt.
- **Remediation:** Treat `auto_approved` as advisory; require signed org-policy proof and/or always prompt on first session; verify broadcast sender identity.

### RDP-3 — Session token + RDP password logged and broadcast *(High)*
- **Evidence:** `realtime_listener.rs:187` logs full payload incl. `session_token`; `rustdesk_host.rs:251` logs password length; password surfaced to dashboard (git `5c0c913`).
- **Remediation:** Never log tokens/payloads/password material; deliver the password only to the authorized viewer over an authenticated channel; decouple from token (RDP-1).

### PAY-2 — No webhook idempotency; replay double-extends license *(High)*
- **Evidence:** `razorpay-webhook/index.ts:151-159` → `extend_subscription_charged` (`0025_…:201-250`) adds a month to `expires_at` with no dedupe on `payment_id`/event id; no `webhook_events` table exists.
- **Remediation:** Add `razorpay_webhook_events(event_id PK)` insert-on-conflict guard; dedupe on `payment_id`.

### PAY-3 / PAY-4 — Access on ₹2 verification, no amount/seat verification *(High)*
- **Evidence:** `razorpay-verify-payment/index.ts:66-79` HMAC is correct but only proves the ₹2 add-on; full plan granted. `razorpay-create-upgrade/index.ts:45,48-50` take `currency` and `seats` from client; no path compares `pay.amount` to `plan.price × seats`.
- **Remediation:** Gate paid activation on `subscription.charged` with server-computed amount; derive seats from the authoritative Razorpay subscription.

### DB-3 — `otp_codes` / `contact_verifications` have no migration / likely no RLS *(High)* **[needs runtime confirmation]**
- **Evidence:** `send-phone-otp` / `verify-phone-otp` use these tables; no `create table`/policy exists in any SQL. If created without RLS, `anon`/`authenticated` can read OTPs or forge verified rows.
- **Remediation:** Add a migration creating both with RLS enabled and service-role-only access.

### INF-1 — Public `rustdesk`/`ffmpeg` buckets feed unverified binaries into signed build *(High)*
- **Evidence:** `0092_rustdesk_binary_bucket.sql:21` (`public, true`); `.github/workflows/build-agent.yml` curls `/object/public/ffmpeg/…` and `/object/public/rustdesk/…` with no checksum, bundles into the codesigned installer.
- **Remediation:** Make buckets private + authenticate the CI download; pin and verify SHA-256 before bundling.

### INF-2 — RustDesk permanent password + host-net + ENCRYPTED_ONLY missing *(High)*
- **Evidence:** `infra/rustdesk/docker-compose.yaml` — header claims `ENCRYPTED_ONLY=1` but it is **not** in the `services` env; both containers `network_mode: host` on public EC2.
- **Remediation:** Add `ENCRYPTED_ONLY=1` to both services; restrict EC2 security group; ship per-session passwords.

### MOB-1 — Mobile session token in WebView localStorage; allowBackup; debuggable debug variant *(High)*
- **Evidence:** `mobile/src/lib/supabase.ts:19-28` localStorage; `mobile/android/app/src/main/AndroidManifest.xml:5` `allowBackup="true"`; debug merged manifest `debuggable="true"`.
- **Remediation:** Keystore/Keychain-backed secure storage adapter; `allowBackup="false"`; confirm release build non-debuggable.

### Medium / Low (summary)
- **API-1** enroll_token long-lived plaintext bearer (`webrtc-signal`, `livekit-token`, `webrtc-turn-credentials` — `.eq("enroll_token", token)`): hash it, add expiry/rotation.
- **DB-4** OTP `Math.random()` + unsalted SHA-256: use `crypto.getRandomValues` + HMAC.
- **INF-3** TURN SHA-1, no owner binding, TURNS off: enable TLS, shorten TTL, coturn quotas.
- **WEB-1** wildcard CORS on sensitive fns: restrict to dashboard origin.
- **PRIV-1** screenshots retained past 90-day log purge; no immutable audit table; `delete-employee` cascades to cloud-account deletion by default.
- **AGT-1** desktop enroll_token/license plaintext in `agent.json`: OS keychain + 0600.
- **MAC-1** `disable-library-validation`, no App Sandbox in `entitlements.plist`.
- **D4** Tauri `csp: null` — set a strict CSP.

---

## 6. Compliance Readiness

| Framework | Status | Key gaps |
|---|---|---|
| **PCI-DSS v4.0** | **Largely N/A — favorable.** No PAN/CVV touches servers/logs; Razorpay-hosted checkout. | Gateway secrets in a DB `integrations` table (should be vault); SAQ-A scope contingent on no card data — confirmed clean. |
| **SOC 2 (Security/Confidentiality)** | **Not ready** | No immutable audit log for purge/delete/remote-control; credential-vault access not least-privilege (DB-1); secret management (OAuth secrets in dotfile). |
| **ISO 27001** | **Partial** | A.9 access control (DB-1/DB-2), A.12 logging (PRIV-1), A.14 secure dev (PAY-1), A.15 supplier/supply-chain (INF-1). |
| **GDPR** | **Gaps** | Storage-limitation breach (screenshots retained past purge); no documented retention for biometric-adjacent screen captures; cascade-delete default-on; right-to-erasure incomplete (objects not purged). |
| **NIST CSF** | Identify/Protect partial; Detect weak (no audit/SIEM); Respond/Recover undocumented. |

---

## 7–13. Domain Ratings

| Domain | Rating | One-line verdict |
|---|---|---|
| **7. Customer Data Protection** | **Moderate–Weak (50/100)** | Storage RLS is correct, but vault RLS (DB-1) and retention/audit gaps mean a low-priv insider or a search_path escalation (DB-2) can reach customer secrets. |
| **8. Payment Security** | **Weak (35/100)** | PCI scope clean, but business-logic bypass (PAY-1) and no idempotency (PAY-2) allow free/extended paid access. |
| **9. Infrastructure** | **Moderate (55/100)** | Public binary buckets + host-net RustDesk + missing ENCRYPTED_ONLY are the main concerns. |
| **10. Mobile** | **Moderate (55/100)** | Insecure token storage + backup + debuggable debug + custom-scheme deep link; PKCE mitigates code theft. |
| **11. Desktop** | **Weak (40/100)** | 32-bit derived RDP password + no-consent auto-approve are critical for an endpoint-control agent. |
| **12. Cloud** | **Moderate (55/100)** | EC2 SG must be the gate (host-net bypasses Docker); buckets/TURN need hardening. |

**Can an attacker access customer information?**
- **Insider (any authenticated org member):** **Yes** — DB-1 exposes the credential vault directly.
- **Privilege escalation:** **Plausibly yes** — DB-2 (search_path) can yield super_admin if schema-create rights aren't locked down. **[needs runtime confirmation]**
- **External unauthenticated:** Storage and most APIs are sound; the practical external paths are payment-logic abuse (PAY-1/2) and, if a token leaks, endpoint takeover (RDP-1/2/3). No direct unauthenticated mass data read was found.

---

## 14. Remediation Roadmap

**Immediate (24 hours)**
1. PAY-1: Stop activating plans/add-ons on `subscription.authenticated`; require verified `subscription.charged` + Razorpay-API `notes`/ownership check.
2. RDP-1: Replace 32-bit derived RDP password with ≥128-bit per-session CSPRNG.
3. RDP-2: Disable client-trusted `auto_approved`; require local consent.
4. DB-1: Revoke `authenticated` SELECT on `credentials`; gate writes to admins.
5. Move `agent.pem` + `.env` out of the working tree; rotate the two OAuth client secrets.

**7-Day**
6. PAY-2/3/4: webhook idempotency table; amount verification; seats from authoritative subscription.
7. DB-2: add `SET search_path` to all SECURITY DEFINER functions.
8. RDP-3: stop logging/broadcasting tokens and password material.
9. INF-1: private buckets + SHA-256 pinning in CI.
10. INF-2: set `ENCRYPTED_ONLY=1`; tighten EC2 security group.

**30-Day**
11. DB-3: migration for `otp_codes`/`contact_verifications` with RLS; CSPRNG + HMAC OTP.
12. MOB-1: secure-storage adapter, `allowBackup=false`, non-debuggable release.
13. API-1: hash + expire enroll_tokens.
14. Tauri CSP; macOS sandbox/library-validation; agent.json keychain.
15. Restrict CORS; enable TURNS.

**90-Day**
16. Immutable audit-event table (purge/delete/remote-control); extend retention purge to storage objects; document retention.
17. SOC 2 / ISO 27001 control mapping; secret-manager migration off DB `integrations`.
18. CI: pin actions to SHAs; consider Apple notarization vs system-wide self-signed CA.
19. Pen-test the live system (staging) to confirm the **[needs runtime confirmation]** items.

---

## 15. Final Executive Verdict

- **Is the platform secure?** Not yet — solid foundations, but Critical payment-logic and remote-control flaws remain.
- **Is customer data protected?** Partially. Storage/RLS for media is correct; the credential vault and privilege model are not.
- **Is payment processing secure?** No. PCI scope is favorable, but the subscription business logic is bypassable.
- **Can attackers compromise accounts?** Plausibly, via privilege escalation (DB-2) and endpoint takeover if a token leaks (RDP-1/2/3); confirm in staging.
- **Can attackers access customer records?** A low-privilege *insider* can (DB-1). External mass-read was not found.
- **Is the application enterprise ready?** Not until the Immediate + 7-Day items are remediated and a SOC 2/audit-logging baseline exists.
- **Would you approve this platform for production deployment?** **Conditional — No-Go as-is.** Approve after the five Immediate fixes ship and the runtime-confirmation items are validated in staging. The codebase is well-structured enough that this is achievable in 1–2 sprints.

---

*Prepared as an executive security audit. All findings are static observations from authorized source review; items marked [needs runtime confirmation] must be validated in a controlled staging environment — not production — before being treated as confirmed-exploitable.*
