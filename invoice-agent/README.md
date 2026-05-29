# Rudrans Invoice Agent

EC2-hosted worker that downloads SaaS invoices for the Credentials Vault.

## Architecture

```
┌─ daily pg_cron @ 06:30 UTC ──────────┐
│  enqueues invoice_fetch_jobs rows    │
└──────────────────────────────────────┘
            │
            ▼  scrape tier (no API connector, no inbound email)
┌─ this worker ────────────────────────┐
│  every 30 s:                         │
│   1. POST /functions/v1/invoice-job-claim         (atomic lock)
│   2. Launch Playwright Chromium                   (headless)
│   3. Drive login via Claude Sonnet 4.6:
│      • screenshot → ask LLM next action
│      • detect OTP screen → POST invoice-otp-request
│        → poll /invoice-otp-status until fulfilled
│        → type code, continue
│   4. Navigate to billing/invoices, download latest PDF
│   5. Persist cookies (encrypt + send back)
│   6. POST /functions/v1/invoice-job-complete       (upload PDF)
└──────────────────────────────────────┘
```

## Setup (on EC2)

```bash
# 1. clone + install
cd /opt && git clone https://github.com/your-org/track-force
cd track-force/invoice-agent
npm ci
npm run install:chromium          # one-time; pulls system deps too

# 2. env
cp .env.example .env
# fill SUPABASE_SERVICE_ROLE_KEY + ANTHROPIC_API_KEY

# 3. systemd
sudo cp systemd/invoice-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now invoice-agent
sudo journalctl -fu invoice-agent      # tail logs
```

## Testing locally

```bash
# Trigger a job from the dashboard's "Test fetch" button on any credential,
# then run the worker once:
HEADLESS=false npm run start            # so you can watch the browser
```

## Cost expectation

- Claude Sonnet 4.6 ≈ $0.03–$0.10 per scrape (avg 10–30 LLM steps × 1k tokens).
- Chromium runs ~250 MB RAM per session; one worker handles ~5 concurrent jobs comfortably on a t3.small.
- Most platforms succeed on the first run; cookies are then reused for 30–90 days, skipping login + LLM entirely.

## Safety

- Decrypted credentials live in worker memory only; never written to disk.
- Cookies are re-encrypted (via `invoice-job-complete`) before persisting.
- 60-min lease on every job — if the worker crashes, another instance reclaims after the lease expires.
- LLM cannot execute arbitrary code; it returns a fixed JSON action vocabulary that this worker dispatches against Playwright. Unrecognised actions abort the job.

## Files

- `src/index.ts`       — main loop (claim → drive → complete)
- `src/llm.ts`         — Claude prompt + action dispatcher
- `src/browser.ts`     — Playwright wrapper + page-state helpers
- `src/otp.ts`         — OTP relay (TOTP local-generate + edge-fn round-trip)
- `src/supabase.ts`    — thin REST client for the four edge fns
- `systemd/invoice-agent.service`
