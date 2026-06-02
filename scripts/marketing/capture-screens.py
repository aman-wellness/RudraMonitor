#!/usr/bin/env python3
"""
Capture real-app screenshots for the marketing video bank.

Run this ONCE (manually) per UI revision. Each capture pass:
  1. Logs into ems.wellnessextract.com with a dedicated MARKETING_DEMO_EMAIL /
     MARKETING_DEMO_PASSWORD account (a real account with seeded fake data
     — NEVER a real customer org).
  2. Visits every row in screens.txt and screenshots the viewport at
     1920×1080 PNG.
  3. Uploads each PNG to the `marketing-app-screens` Supabase Storage bucket
     using the service role key.
  4. Rewrites the `index.json` blob in that bucket so generate.py knows
     which keys are available and where the PNG lives.

If you skip running this, generate.py degrades gracefully — `app_screen`
scenes in styles will be substituted with DALL-E illustrations.

Env vars required:
  MARKETING_DEMO_EMAIL          login email for the demo org
  MARKETING_DEMO_PASSWORD       login password
  SUPABASE_URL                  e.g. https://api-ems.wellnessextract.com
  SUPABASE_SERVICE_ROLE_KEY     service-role JWT (the one generate.py uses)

Optional:
  APP_URL                       default https://ems.wellnessextract.com
  SCREENS_FILE                  default scripts/marketing/screens.txt
  ONLY_KEY                      capture just one row's screen (for iteration)
  HEADFUL                       set to 1 to watch the browser run

Usage:
  pip install playwright requests && playwright install chromium
  python scripts/marketing/capture-screens.py
  python scripts/marketing/capture-screens.py ONLY_KEY=dashboard

Cost: zero. Time: ~1.5 min for 22 screens.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

# Lazy import — Playwright is a heavy dep we don't want generate.py (which
# runs on the cron host) to need just for the import.
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit(
        "playwright not installed. Run: pip install playwright && playwright install chromium"
    )

APP_URL          = os.environ.get("APP_URL", "https://ems.wellnessextract.com").rstrip("/")
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "").rstrip("/")
SR_KEY           = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
DEMO_EMAIL       = os.environ.get("MARKETING_DEMO_EMAIL", "")
DEMO_PASSWORD    = os.environ.get("MARKETING_DEMO_PASSWORD", "")
SCREENS_FILE     = os.environ.get("SCREENS_FILE", "scripts/marketing/screens.txt")
BUCKET           = "marketing-app-screens"
INDEX_REMOTE     = "index.json"
HEADFUL          = os.environ.get("HEADFUL") == "1"
ONLY_KEY         = os.environ.get("ONLY_KEY", "").strip()

for name, val in (
    ("SUPABASE_URL", SUPABASE_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SR_KEY),
    ("MARKETING_DEMO_EMAIL", DEMO_EMAIL),
    ("MARKETING_DEMO_PASSWORD", DEMO_PASSWORD),
):
    if not val:
        sys.exit(f"env var {name} required")

# --- Screens file parsing -------------------------------------------------

def parse_screens(path: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        if len(parts) < 2:
            print(f"[warn] skipping malformed row: {raw!r}")
            continue
        key, rel = parts[0], parts[1]
        wait_sel = parts[2].strip() if len(parts) > 2 else "_"
        rows.append({"key": key, "path": rel, "wait": "" if wait_sel == "_" else wait_sel})
    return rows

# --- Supabase Storage upload ----------------------------------------------

def upload_png(local_bytes: bytes, remote_path: str, content_type: str = "image/png") -> str:
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{remote_path}"
    r = requests.put(
        url,
        headers={
            "Authorization": f"Bearer {SR_KEY}",
            "Content-Type": content_type,
            "x-upsert": "true",
        },
        data=local_bytes,
        timeout=120,
    )
    if not r.ok:
        # Fallback to POST for buckets that reject PUT on first write.
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {SR_KEY}",
                "Content-Type": content_type,
            },
            data=local_bytes,
            timeout=120,
        )
    if not r.ok:
        raise RuntimeError(f"upload failed {url}: {r.status_code} {r.text[:200]}")
    return remote_path

def fetch_index() -> dict[str, str]:
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{INDEX_REMOTE}"
    r = requests.get(url, headers={"Authorization": f"Bearer {SR_KEY}"}, timeout=30)
    if r.status_code == 404:
        return {}
    if not r.ok:
        print(f"[warn] couldn't fetch existing index ({r.status_code}); starting fresh")
        return {}
    try:
        data = r.json()
        return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}
    except Exception:
        return {}

# --- Playwright capture ---------------------------------------------------

def capture_all(rows: list[dict[str, str]]) -> dict[str, str]:
    """Returns {key: remote_path} for everything successfully captured."""
    out: dict[str, str] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADFUL)
        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
            # Force light theme off — Rudrans default is dark, which photographs better.
            color_scheme="dark",
        )
        page = ctx.new_page()

        # 1. Log in once.
        print(f"[login] opening {APP_URL}/login")
        page.goto(f"{APP_URL}/login", wait_until="networkidle")
        # Fill the email + password (LoginLayout uses standard inputs).
        page.fill('input[type=email]', DEMO_EMAIL)
        page.fill('input[type=password]', DEMO_PASSWORD)
        page.click('button[type=submit]')
        # Wait for either /dashboard or /post-login to settle.
        try:
            page.wait_for_url("**/dashboard*", timeout=20_000)
        except Exception:
            try:
                page.wait_for_url("**/post-login*", timeout=10_000)
                page.wait_for_url("**/dashboard*", timeout=20_000)
            except Exception as e:
                page.screenshot(path="/tmp/login-fail.png")
                raise RuntimeError(
                    f"login flow did not land on /dashboard: {e}. "
                    "Screenshot at /tmp/login-fail.png — check demo account creds."
                )
        print("[login] OK")
        # Give the dashboard a moment for hydration.
        time.sleep(2.0)

        # 2. Loop screens.
        for row in rows:
            if ONLY_KEY and row["key"] != ONLY_KEY:
                continue
            url = f"{APP_URL}{row['path']}"
            print(f"[capture] {row['key']:30s} → {url}")
            try:
                page.goto(url, wait_until="networkidle", timeout=30_000)
                if row["wait"]:
                    page.wait_for_selector(row["wait"], timeout=15_000)
                # Tiny extra settle for charts / images / icons.
                time.sleep(1.5)
                png_bytes = page.screenshot(full_page=False, type="png")
                remote = f"{row['key']}.png"
                upload_png(png_bytes, remote)
                out[row["key"]] = remote
            except Exception as e:
                print(f"[warn] capture failed for {row['key']}: {e}")

        browser.close()
    return out

# --- Main -----------------------------------------------------------------

def main() -> None:
    rows = parse_screens(SCREENS_FILE)
    print(f"[plan] {len(rows)} screens to capture from {SCREENS_FILE}")
    if ONLY_KEY:
        print(f"[plan] ONLY_KEY={ONLY_KEY!r} — capturing one screen")

    captured = capture_all(rows)
    print(f"[capture] {len(captured)}/{len(rows)} succeeded")

    # 3. Merge with existing index so a partial re-run (ONLY_KEY=...) does
    # not blow away unrelated entries.
    existing = fetch_index()
    existing.update(captured)
    payload = json.dumps(existing, indent=2, sort_keys=True).encode("utf-8")
    upload_png(payload, INDEX_REMOTE, content_type="application/json")
    print(f"[index] wrote {len(existing)} entries to {BUCKET}/{INDEX_REMOTE}")

    # Summary
    print()
    print(f"  bank now has {len(existing)} screens:")
    for k in sorted(existing.keys()):
        marker = "✓ new" if k in captured else "  "
        print(f"    {marker}  {k}")

if __name__ == "__main__":
    main()
