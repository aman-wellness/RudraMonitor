#!/usr/bin/env python3
"""
AI-driven marketing content generator. Runs on the EC2 host on a systemd
timer (daily + weekly) and produces:

    daily  → 1 short_video draft (~30s) + post captions for 4 platforms
    weekly → 1 long_video draft (~5min) + post captions for 4 platforms

What changed from the slideshow-only v1:
  - Multiple video STYLES rotate per cycle (product-tour, problem-solution,
    feature-spotlight, before-after, compare-vs-competitor,
    tutorial-walkthrough). The chosen style picks scene_count + scene_recipe
    so videos look different every day instead of every one being a generic
    Ken Burns slideshow.
  - Each scene can be one of THREE types:
      app_screen   → real PNG from the marketing-app-screens bucket
                     (populated by capture-screens.py, indexed by feature key)
      illustration → DALL-E 3 / gpt-image-1 synthetic image (existing path)
      text_card    → ffmpeg-rendered title card on solid brand bg (free)
    The mix gives videos actual Rudrans UI footage instead of only synthetic
    AI art, and cuts cost (text_cards are free, screenshots are cached).
  - generate.py also picks up `regen_requested` drafts from the marketing
    queue so the admin's "Regenerate with style X" button feeds back here.

The whole pipeline still uses ONE OpenAI key (MARKETING_OPENAI_API_KEY) and
the host's ffmpeg binary. No third-party SaaS.

Usage:
    generate.py --kind=daily
    generate.py --kind=weekly
    generate.py --kind=daily --style=product-tour    # manual override
    generate.py --kind=daily --dry-run               # print plan, no OpenAI/ffmpeg
"""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
import requests

# --- Config from env -------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL",  "http://localhost:8000")
SR_KEY      = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PG_DSN      = os.environ.get("PG_DSN", "postgresql://postgres:postgres@localhost:5432/postgres")
BUCKET             = "marketing-media"          # video / audio / generated images
APP_SCREENS_BUCKET = "marketing-app-screens"    # pre-captured real-app PNG bank
APP_SCREENS_INDEX  = "index.json"               # bucket-relative path to the screen index

if not SR_KEY:
    sys.exit("SUPABASE_SERVICE_ROLE_KEY not set")

OPENAI_KEY: str = ""
OPENAI_API = "https://api.openai.com/v1"

# Brand colors used by the text_card scene renderer. Keep in sync with the
# dashboard's tailwind theme so videos feel on-brand.
BRAND_BG     = "0e1116"   # dark-900-ish
BRAND_ACCENT = "10b981"   # emerald-500

# --- Style library ---------------------------------------------------------
#
# Each style is a template. The cron picks one per run; the admin can also
# force a specific style via --style or the regenerate-with-style UI button.
#
# scene_recipe slots:
#   "app_screen"   — real Rudrans UI screenshot from the bucket
#   "illustration" — DALL-E synthetic image
#   "text_card"    — ffmpeg drawtext card (free, no AI cost)
#
# Daily styles are ≤45s and target 5-7 scenes. Weekly styles are 5min and
# target 15-22 scenes. Editing this constant + redeploying generate.py is
# the canonical way to add or tune styles — kept out of the DB so iteration
# stays fast (no migration per tweak).

STYLE_LIBRARY: dict[str, dict[str, Any]] = {
    "product-tour": {
        "kind": "short",
        "duration_sec": 35,
        "scene_count": 7,
        "scene_recipe": [
            "text_card", "app_screen", "app_screen", "app_screen",
            "app_screen", "app_screen", "text_card",
        ],
        "prompt_addendum": (
            "Write this as a guided PRODUCT TOUR. The narrator walks the viewer "
            "through 5 different Rudrans screens in 30 seconds — one sentence per "
            "screen, naming the screen and the ONE thing it does. Open with a "
            "title card ('Rudrans in 30 seconds'), end with a CTA card "
            "('Start a 14-day free trial · ems.wellnessextract.com'). Pick distinct "
            "screen_keys for each app_screen scene — no repeats."
        ),
    },
    "problem-solution": {
        "kind": "short",
        "duration_sec": 30,
        "scene_count": 5,
        "scene_recipe": ["text_card", "illustration", "text_card", "app_screen", "app_screen"],
        "prompt_addendum": (
            "Write this as a PROBLEM → SOLUTION arc. Scene 1: text card stating "
            "the problem (e.g. 'Your remote team's 2pm productivity drop costs you "
            "$X/year'). Scene 2: illustration showing the pain. Scene 3: text card "
            "with the turn ('Here's what flips it'). Scenes 4-5: show Rudrans "
            "screens that solve it. Narration is conversational, ~70 words total."
        ),
    },
    "feature-spotlight": {
        "kind": "short",
        "duration_sec": 25,
        "scene_count": 5,
        "scene_recipe": ["text_card", "app_screen", "app_screen", "app_screen", "text_card"],
        "prompt_addendum": (
            "Pick ONE feature from the value_props list and go deep on it. Title "
            "card names the feature, three app_screen scenes show the feature in "
            "context (different views/states of the same screen if possible), end "
            "with a CTA card. Narration tells a 30-second 'this is why this matters' "
            "story — not a generic feature list."
        ),
    },
    "before-after": {
        "kind": "short",
        "duration_sec": 30,
        "scene_count": 6,
        "scene_recipe": ["text_card", "illustration", "illustration", "text_card", "app_screen", "app_screen"],
        "prompt_addendum": (
            "Show a BEFORE / AFTER split: scenes 1-3 establish the messy 'before' "
            "(no monitoring, no DLP, no idea who's productive) using illustrations; "
            "scene 4 is a transitional text card ('After installing Rudrans:'); "
            "scenes 5-6 show the Rudrans dashboard delivering the answer. The "
            "narration mirrors the visual arc — first half is pain, second half is relief."
        ),
    },
    "compare-vs-competitor": {
        "kind": "short",
        "duration_sec": 40,
        "scene_count": 7,
        "scene_recipe": ["text_card", "text_card", "app_screen", "text_card", "app_screen", "app_screen", "text_card"],
        "prompt_addendum": (
            "Compare Rudrans against a generic 'legacy employee-monitoring tool' "
            "WITHOUT naming a competitor (avoid trademark / disparagement). Use "
            "text cards as the comparison rows ('Per-seat pricing: Rudrans yes / "
            "Legacy no'), interleaved with screens showing each Rudrans advantage "
            "in action. Tone: confident but factual, never snarky."
        ),
    },
    "tutorial-walkthrough": {
        "kind": "short",
        "duration_sec": 45,
        "scene_count": 7,
        "scene_recipe": ["text_card", "app_screen", "app_screen", "app_screen", "app_screen", "app_screen", "text_card"],
        "prompt_addendum": (
            "Pick ONE common admin task (install agent / grant employee credential "
            "access / read a DLP alert / approve an OTP request / view live screen) "
            "and walk through it step-by-step. The 5 app_screen scenes should be a "
            "sequence — first → next → next — using screens that actually exist in "
            "the index. The narration mirrors each step plainly: 'first you …, then …'."
        ),
    },

    # --- Weekly long-form variants ------------------------------------------
    "tutorial-walkthrough-long": {
        "kind": "long",
        "duration_sec": 300,
        "scene_count": 18,
        "scene_recipe": (
            ["text_card"] + ["app_screen"] * 14 + ["illustration"] * 2 + ["text_card"]
        ),
        "prompt_addendum": (
            "5-minute deep dive on the full Rudrans admin journey: onboarding → "
            "agent install → daily monitoring → handling an alert → using DLP → "
            "credentials vault → offboarding. Narration ~750 words, conversational. "
            "The 14 app_screen scenes must cover at least 10 distinct screen_keys "
            "(some repeated when revisited). Illustrations break up the middle for "
            "pacing. Open + close with text cards."
        ),
    },
    "product-tour-long": {
        "kind": "long",
        "duration_sec": 300,
        "scene_count": 20,
        "scene_recipe": (
            ["text_card"] + ["app_screen"] * 16 + ["text_card"] * 2 + ["app_screen"]
        ),
        "prompt_addendum": (
            "Comprehensive 5-minute tour of EVERY top-level area of the Rudrans "
            "dashboard. Spend ~18 seconds per area: monitoring, agents, alerts, "
            "DLP, system health, employees, credentials, hardware, integrations, "
            "admin portal. Open with a hook card, close with a CTA card."
        ),
    },
}

# Lazy index from style.kind -> list[style_name] so rotation picks a sensible
# style for the requested cron kind.
def _styles_by_kind(kind: str) -> list[str]:
    want = "long" if kind == "weekly" else "short"
    return [n for n, s in STYLE_LIBRARY.items() if s["kind"] == want]

# --- OpenAI helpers --------------------------------------------------------

PRICE = {
    "gpt4o_in_per_1k":  0.0025,
    "gpt4o_out_per_1k": 0.010,
    "dalle3_std":       0.040,
    "tts1_per_1k_char": 0.015,
}

def _gpt_cost(usage: dict | None) -> float:
    if not usage: return 0.0
    p = usage.get("prompt_tokens", 0) / 1000 * PRICE["gpt4o_in_per_1k"]
    c = usage.get("completion_tokens", 0) / 1000 * PRICE["gpt4o_out_per_1k"]
    return round(p + c, 4)

def search_trends(prompt: str) -> tuple[str, float]:
    r = requests.post(
        f"{OPENAI_API}/responses",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o",
            "input": prompt,
            "tools": [{"type": "web_search"}],
            "temperature": 0.7,
        },
        timeout=120,
    )
    if r.ok:
        j = r.json()
        return (j.get("output_text", "") or "", _gpt_cost(j.get("usage")))
    print(f"[warn] responses API rejected, falling back: {r.status_code} {r.text[:200]}")
    r = requests.post(
        f"{OPENAI_API}/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
        },
        timeout=120,
    )
    r.raise_for_status()
    j = r.json()
    return (j["choices"][0]["message"]["content"], _gpt_cost(j.get("usage")))

def json_chat(system: str, user: str) -> tuple[dict[str, Any], float]:
    r = requests.post(
        f"{OPENAI_API}/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.8,
        },
        timeout=120,
    )
    r.raise_for_status()
    j = r.json()
    return (json.loads(j["choices"][0]["message"]["content"]), _gpt_cost(j.get("usage")))

def gen_image(prompt: str, out_path: Path, size: str = "1024x1024") -> float:
    r = requests.post(
        f"{OPENAI_API}/images/generations",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-image-1",
            "prompt": prompt[:3500],
            "size": size,
            "n": 1,
            "quality": "medium",
        },
        timeout=180,
    )
    if not r.ok:
        print(f"[warn] DALL-E image failed for prompt {prompt[:60]!r}: {r.status_code} {r.text[:200]}")
        return 0.0
    j = r.json()
    item = (j.get("data") or [{}])[0]
    if item.get("b64_json"):
        import base64
        out_path.write_bytes(base64.b64decode(item["b64_json"]))
    elif item.get("url"):
        dl = requests.get(item["url"], timeout=120)
        dl.raise_for_status()
        out_path.write_bytes(dl.content)
    else:
        print(f"[warn] DALL-E response had neither url nor b64_json: {j}")
        return 0.0
    return PRICE["dalle3_std"]

def tts(text: str, out_path: Path, voice: str = "nova") -> float:
    r = requests.post(
        f"{OPENAI_API}/audio/speech",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={"model": "tts-1", "voice": voice, "input": text, "response_format": "mp3"},
        timeout=120,
    )
    r.raise_for_status()
    out_path.write_bytes(r.content)
    return round(len(text) / 1000 * PRICE["tts1_per_1k_char"], 4)

# --- App-screen bank -------------------------------------------------------

def _storage_get(bucket: str, remote_path: str) -> bytes | None:
    """Service-role download from a private bucket. Returns bytes or None
    if the object doesn't exist. Other failures raise.

    self-hosted Supabase Storage returns HTTP 400 (not 404) with body
    `{"statusCode":"404","error":"not_found",...}` for a missing object,
    so we sniff the body too — otherwise an empty bank crashes the
    daemon instead of taking the graceful "fall back to illustrations" path.
    """
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{remote_path}"
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {SR_KEY}"},
        timeout=120,
    )
    if r.status_code == 404:
        return None
    if r.status_code == 400:
        try:
            j = r.json()
            if str(j.get("statusCode")) == "404" or j.get("error") == "not_found":
                return None
        except Exception:
            pass
    if not r.ok:
        raise RuntimeError(f"storage GET failed {url}: {r.status_code} {r.text[:200]}")
    return r.content

def load_screen_index() -> dict[str, str]:
    """Returns { screen_key: bucket_relative_path }. Empty dict if the
    bank hasn't been populated yet (capture-screens.py not run). The
    daemon then falls back to illustrations for any app_screen slot,
    so the pipeline never hard-fails on a missing index."""
    raw = _storage_get(APP_SCREENS_BUCKET, APP_SCREENS_INDEX)
    if raw is None:
        return {}
    try:
        idx = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print(f"[warn] screen index parse error: {e}")
        return {}
    # Accept either { key: "path.png" } or { key: { "path": "...", ... } }
    out: dict[str, str] = {}
    for k, v in (idx if isinstance(idx, dict) else {}).items():
        if isinstance(v, str):
            out[k] = v
        elif isinstance(v, dict) and isinstance(v.get("path"), str):
            out[k] = v["path"]
    return out

def download_screen(remote_path: str, out_path: Path) -> bool:
    data = _storage_get(APP_SCREENS_BUCKET, remote_path)
    if data is None:
        return False
    out_path.write_bytes(data)
    return True

# --- ffmpeg scene rendering ------------------------------------------------

def render_text_card(text: str, out_path: Path) -> None:
    """Solid brand-bg PNG with centered white text. No AI cost. Used for
    title / CTA / transition slides in the style recipes.

    SECURITY: ffmpeg's drawtext filter has its own escape syntax (backslashes,
    colons, percent-signs, single quotes) that is fragile to harden against
    LLM-generated text. We sidestep that entirely by writing the caption to a
    tempfile and using textfile= — ffmpeg reads the file as raw bytes and does
    no filter-string interpolation on the content.
    """
    rendered = text
    # Two-line wrap heuristic: split at the midpoint nearest a space if the
    # text is long enough to wrap naturally.
    if len(text) > 40:
        mid = len(text) // 2
        wrap_at = text.rfind(" ", 0, mid + 10)
        if wrap_at > 10:
            rendered = text[:wrap_at] + "\n" + text[wrap_at + 1:]
    # Reject control bytes that could confuse ffmpeg's textfile reader.
    rendered = "".join(ch for ch in rendered if ch == "\n" or ord(ch) >= 0x20)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write(rendered)
        textfile_path = tf.name
    try:
        subprocess.run(
            ["ffmpeg", "-y",
             "-f", "lavfi", "-i", f"color=c=0x{BRAND_BG}:s=1024x1024:d=1",
             "-vf",
             (
                f"drawtext=textfile='{textfile_path}':fontcolor=white:fontsize=56:"
                f"box=0:x=(w-text_w)/2:y=(h-text_h)/2:"
                f"line_spacing=18"
                f",drawbox=x=(iw-360)/2:y=ih/2+120:w=360:h=6:color=0x{BRAND_ACCENT}@1.0:t=fill"
             ),
             "-frames:v", "1", str(out_path)],
            check=True, capture_output=True,
        )
    finally:
        try:
            os.unlink(textfile_path)
        except OSError:
            pass

# --- ffmpeg video assembly -------------------------------------------------

def assemble_video(
    images: list[tuple[Path, str]],
    audio_path: Path,
    out_path: Path,
    hook_title: str | None = None,
) -> None:
    """Concatenate per-scene clips into final.mp4 with audio.

    images: list of (image_path, scene_type) so the per-clip filter can
            choose Ken Burns vs hold-still appropriately:
              illustration  → Ken Burns zoom (movement adds life to flat AI art)
              app_screen    → HOLD STILL (zooming on a UI screenshot looks weird)
              text_card     → HOLD STILL with a 0.3s fade-in
    """
    if not images:
        raise RuntimeError("no images to assemble")

    probe = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
    ).decode().strip()
    audio_secs = max(float(probe), 1.0)
    per = max(2.0, min(6.0, audio_secs / len(images)))

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        clip_paths: list[Path] = []
        for i, (img, scene_type) in enumerate(images):
            clip = td_path / f"clip-{i:02d}.mp4"
            if scene_type == "illustration":
                # Ken Burns slow zoom — adds motion to static AI art.
                main_filter = (
                    "zoompan="
                    f"z='min(zoom+0.0015,1.15)':"
                    f"d={int(per*30)}:"
                    "x='iw/2-(iw/zoom/2)':"
                    "y='ih/2-(ih/zoom/2)':"
                    "s=1080x1080:fps=30"
                )
            else:
                # Hold still — UI screenshots and text cards look amateur
                # if they wobble. Just scale + pad to 1080x1080 square.
                main_filter = (
                    "scale=1080:1080:force_original_aspect_ratio=decrease,"
                    "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x000000,"
                    "fps=30"
                )
                if scene_type == "text_card":
                    # Gentle 0.3s fade-in so cards don't pop.
                    main_filter += ",fade=in:st=0:d=0.3"

            text_overlay = ""
            hook_textfile: str | None = None
            if i == 0 and hook_title:
                # SECURITY: same rationale as render_text_card — hook_title
                # is LLM-generated, so write it to a tempfile and use
                # textfile= so the filter parser never sees the content.
                cleaned = "".join(ch for ch in hook_title if ch == "\n" or ord(ch) >= 0x20)
                with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
                    tf.write(cleaned)
                    hook_textfile = tf.name
                text_overlay = (
                    f",drawtext=textfile='{hook_textfile}':"
                    "fontcolor=white:fontsize=44:"
                    "box=1:boxcolor=black@0.6:boxborderw=20:"
                    "x=(w-text_w)/2:y=h-180:"
                    "enable='between(t,0,2.5)'"
                )

            try:
                subprocess.run(
                    ["ffmpeg", "-y", "-loop", "1", "-i", str(img),
                     "-vf", main_filter + text_overlay,
                     "-t", f"{per}",
                     "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "fast",
                     "-an", str(clip)],
                    check=True, capture_output=True,
                )
            finally:
                if hook_textfile:
                    try: os.unlink(hook_textfile)
                    except OSError: pass
            clip_paths.append(clip)

        list_file = td_path / "concat.txt"
        list_file.write_text("\n".join(f"file '{p}'" for p in clip_paths))
        silent_video = td_path / "video.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
             "-c", "copy", str(silent_video)],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(silent_video), "-i", str(audio_path),
             "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
             "-shortest", str(out_path)],
            check=True, capture_output=True,
        )

# --- Supabase Storage upload ----------------------------------------------

def upload(local: Path, remote_path: str, content_type: str, bucket: str = BUCKET) -> str:
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{remote_path}"
    r = requests.put(
        url,
        headers={
            "Authorization": f"Bearer {SR_KEY}",
            "Content-Type": content_type,
            "x-upsert": "true",
        },
        data=local.read_bytes(),
        timeout=300,
    )
    if not r.ok:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {SR_KEY}",
                "Content-Type": content_type,
            },
            data=local.read_bytes(),
            timeout=300,
        )
    if not r.ok:
        raise RuntimeError(f"upload failed {url}: {r.status_code} {r.text[:200]}")
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{remote_path}"

# --- DB ops ----------------------------------------------------------------

def load_settings(cur) -> dict[str, Any]:
    cur.execute(
        "SELECT brand_voice, value_props, target_audience, content_style, "
        "visual_style, enabled FROM marketing_settings WHERE id=1"
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError("marketing_settings row missing — seed migration didn't run?")
    return dict(row)

def load_openai_key(cur) -> str:
    cur.execute(
        "SELECT value FROM integrations WHERE key='MARKETING_OPENAI_API_KEY'"
    )
    row = cur.fetchone()
    db_value = (row.get("value") if row else None) or ""
    if db_value.strip():
        return db_value.strip()
    env_value = os.environ.get("MARKETING_OPENAI_API_KEY", "").strip()
    if env_value:
        return env_value
    raise RuntimeError(
        "MARKETING_OPENAI_API_KEY not set anywhere. Set it in the "
        "super-admin dashboard at /admin/integrations (Marketing OpenAI Key)."
    )

def already_generated_today(cur, kind: str, today: dt.date) -> bool:
    cur.execute(
        "SELECT 1 FROM marketing_drafts WHERE kind=%s AND scheduled_for=%s LIMIT 1",
        (kind, today),
    )
    return cur.fetchone() is not None

def claim_pending_regen(cur) -> dict[str, Any] | None:
    """Atomically claims the oldest `regen_requested` row by flipping it
    to `pending` (so a concurrent timer tick doesn't re-claim it). Returns
    {id, kind, requested_style} so main() can run that draft's regen
    instead of the daily/weekly default. Returns None if the queue is empty."""
    cur.execute(
        """
        UPDATE public.marketing_drafts
        SET status = 'pending'
        WHERE id = (
          SELECT id FROM public.marketing_drafts
          WHERE status = 'regen_requested'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, kind, requested_style
        """,
    )
    row = cur.fetchone()
    return dict(row) if row else None

def insert_draft(cur, draft: dict[str, Any]) -> str:
    cur.execute(
        """
        INSERT INTO marketing_drafts (
          kind, status, trend_source, hook_title, script, captions,
          scene_prompts, image_urls, audio_url, video_url, scheduled_for,
          openai_cost_usd, generation_meta, style, scene_types
        ) VALUES (
          %(kind)s, 'pending', %(trend)s, %(hook)s, %(script)s, %(captions)s,
          %(scene_prompts)s, %(image_urls)s, %(audio_url)s, %(video_url)s,
          %(scheduled_for)s, %(cost)s, %(meta)s, %(style)s, %(scene_types)s
        ) RETURNING id
        """,
        draft,
    )
    return cur.fetchone()["id"]

# --- Style picking + prompt build ------------------------------------------

def pick_style(kind: str, override: str | None, today: dt.date) -> str:
    """Resolve which style to use.
       override (admin's --style or regen request) wins if it exists in the library.
       Otherwise rotate based on day-of-year so consecutive days use different styles.
    """
    if override and override in STYLE_LIBRARY:
        wanted_kind = "long" if kind == "weekly" else "short"
        if STYLE_LIBRARY[override]["kind"] == wanted_kind:
            return override
        print(f"[warn] override style {override!r} is for a different kind; falling back to rotation")
    candidates = _styles_by_kind(kind)
    if not candidates:
        raise RuntimeError(f"no styles registered for kind={kind!r}")
    return candidates[today.timetuple().tm_yday % len(candidates)]

def build_user_prompt(
    s: dict[str, Any],
    trend_text: str,
    style_name: str,
    style: dict[str, Any],
    screen_keys: list[str],
) -> str:
    """User prompt for the GPT-4o plan call. Returns JSON describing
    structured scenes: each scene is {type: 'app_screen'|'illustration'|'text_card',
    value: '<screen_key | image_prompt | card_text>'}.

    The scene_recipe is given to the model so it knows the EXACT type
    sequence — the model only fills in the `value` field per scene."""
    scene_count = style["scene_count"]
    recipe_lines = "\n".join(
        f"  scene {i+1}: type={t} → {_scene_type_hint(t, screen_keys)}"
        for i, t in enumerate(style["scene_recipe"])
    )
    keys_str = ", ".join(screen_keys) if screen_keys else "(NONE — bank empty, you MUST output illustration values for app_screen slots instead)"

    word_target = "~70 words" if style["kind"] == "short" else "~750 words"
    return f"""
Brand voice: {s['brand_voice']}
Value props: {", ".join(s['value_props'])}
Target audience: {s['target_audience']}
Content style: {s['content_style']}
Visual style for DALL-E image scenes: {s['visual_style']}

Today's trend to anchor on:
{trend_text}

STYLE: {style_name} (target {style['duration_sec']}s, {scene_count} scenes)
{style['prompt_addendum']}

The scene sequence is FIXED. Fill each scene's value according to its type:
{recipe_lines}

Available app screen keys (use EXACTLY these strings for app_screen.value):
{keys_str}

JSON schema (output STRICTLY this shape, no extra fields):
{{
  "hook_title": "string — 6-8 word hook overlaid on the first frame",
  "script":     "string — narrator script. {word_target}. Conversational. No 'um's. ONE big idea.",
  "scenes": [
    {{ "type": "app_screen|illustration|text_card", "value": "string" }}
    ... exactly {scene_count} entries, in the order specified above
  ],
  "captions": {{
    "linkedin":  "string — 1200 chars max, ~3 short paragraphs, opens with the hook",
    "x":         "string — 270 chars max, punchy",
    "instagram": "string — 1500 chars max, 5-10 relevant hashtags at the end",
    "facebook":  "string — 1500 chars max, conversational"
  }}
}}

Rules:
- For app_screen scenes: value MUST be one of the screen keys above. If the
  bank is empty, EMIT an illustration scene instead (set type='illustration'
  and write a DALL-E prompt as value).
- For illustration scenes: value is a DALL-E prompt (no text in image; the
  visual style above is auto-appended by the daemon).
- For text_card scenes: value is the short text to display (≤ 60 chars,
  single sentence, no emoji).
- The first frame's hook_title appears as an OVERLAY only — do not include
  it in any scene value."""

def _scene_type_hint(t: str, screen_keys: list[str]) -> str:
    if t == "app_screen":
        return "pick a screen_key from the bank"
    if t == "illustration":
        return "DALL-E image prompt"
    return "short text card content (≤60 chars)"

# --- Main ------------------------------------------------------------------

def main(kind: str, style_override: str | None = None, dry_run: bool = False) -> None:
    if kind not in ("daily", "weekly"):
        sys.exit(f"unknown kind {kind!r}")
    today = dt.date.today()
    total_cost = 0.0

    conn = psycopg2.connect(PG_DSN, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    try:
        # 0. Look for a pending regen request first — if the admin clicked
        # "Regenerate" / "Regenerate with style X" in /admin/marketing, that
        # row gets processed instead of (or in addition to) the daily run.
        regen: dict[str, Any] | None = None
        with conn.cursor() as cur:
            regen = None if dry_run else claim_pending_regen(cur)
            if regen:
                # Map the row kind back to the cron kind for prompt selection.
                kind = "weekly" if regen.get("kind") == "long_video" else "daily"
                style_override = regen.get("requested_style") or style_override
                print(f"[regen] picked up draft {regen['id']} kind={regen['kind']} requested_style={regen.get('requested_style')!r}")
        if regen:
            conn.commit()  # release the lock from claim_pending_regen

        row_kind = "long_video" if kind == "weekly" else "short_video"

        with conn.cursor() as cur:
            # Idempotency only applies to the daily/weekly cron path; regens
            # are explicitly user-requested so they always run.
            if not regen and already_generated_today(cur, row_kind, today):
                print(f"already generated {kind} for {today}, skipping")
                return
            s = load_settings(cur)
            if not s.get("enabled", True):
                print(f"marketing_settings.enabled = false, skipping {kind} run (no OpenAI calls).")
                return
            if not dry_run:
                global OPENAI_KEY
                OPENAI_KEY = load_openai_key(cur)
                print(f"openai key loaded ({len(OPENAI_KEY)} chars)")

        # 1. Pick style + load screen bank.
        style_name = pick_style(kind, style_override, today)
        style = STYLE_LIBRARY[style_name]
        screen_index = load_screen_index() if not dry_run else {"dashboard": "dashboard.png", "monitoring-live": "monitoring-live.png"}
        screen_keys = sorted(screen_index.keys())
        print(f"[style] {style_name} · {style['duration_sec']}s · {style['scene_count']} scenes · recipe={style['scene_recipe']}")
        print(f"[bank] {len(screen_keys)} screens available: {', '.join(screen_keys[:10])}{'…' if len(screen_keys) > 10 else ''}")
        if not screen_keys and any(t == "app_screen" for t in style["scene_recipe"]):
            print("[warn] app_screen slots in recipe but bank is empty — model will substitute illustrations")

        # 2. Trend search.
        if dry_run:
            trend_text = "(dry-run skipped trend search)"
        else:
            trend_prompt = (
                "Find ONE timely, specific news angle from the past 7 days about "
                "employee monitoring, remote-work productivity, data loss prevention, "
                "or IT compliance that would resonate with: "
                f"{s['target_audience']}. "
                "Reply with: 1) one-sentence summary, 2) why it matters, 3) the "
                "primary source URL. Be specific, not generic."
            )
            trend_text, c = search_trends(trend_prompt); total_cost += c
            print(f"[trend] {trend_text[:200]}…")

        # 3. Plan + script + captions JSON.
        system = (
            "You are a senior B2B SaaS content marketer. You write hooks that "
            "make IT managers stop scrolling. You never use corporate jargon. "
            "You match the requested STYLE template precisely. "
            "Output STRICT JSON only."
        )
        user = build_user_prompt(s, trend_text, style_name, style, screen_keys)

        if dry_run:
            print("[dry-run] system prompt:")
            print(system)
            print("[dry-run] user prompt:")
            print(user)
            return

        plan, c = json_chat(system, user); total_cost += c
        scenes = plan.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            raise RuntimeError(f"plan returned no scenes: {plan}")
        # Trim/pad to recipe length so ffmpeg pacing is predictable.
        scenes = scenes[:style["scene_count"]]
        # Guard: scenes the model emitted that reference a missing screen_key
        # get downgraded to an illustration with the same value as a hint.
        for sc in scenes:
            if sc.get("type") == "app_screen" and sc.get("value") not in screen_index:
                print(f"[warn] model picked unknown screen_key {sc.get('value')!r} — downgrading to illustration")
                sc["type"] = "illustration"
                sc["value"] = f"A modern flat-design illustration of {sc.get('value', 'a SaaS dashboard view')}"
        print(f"[plan] hook={plan.get('hook_title','?')!r}  scenes={len(scenes)}  types={[s['type'] for s in scenes]}")

        # 4. Render each scene → image PNG.
        scene_types: list[str] = []
        scene_prompt_audit: list[str] = []
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            images: list[tuple[Path, str]] = []  # (path, scene_type)
            image_urls: list[str] = []
            for i, sc in enumerate(scenes):
                out = tdp / f"scene-{i:02d}.png"
                t = sc.get("type", "illustration")
                value = sc.get("value", "")
                if t == "app_screen":
                    ok = download_screen(screen_index[value], out)
                    if not ok:
                        print(f"[warn] screen {value!r} listed in index but object missing; substituting illustration")
                        t = "illustration"
                        value = f"A clean SaaS dashboard view — {value}"
                if t == "illustration":
                    styled_prompt = f"{value}. Visual style: {s['visual_style']}."
                    c = gen_image(styled_prompt, out); total_cost += c
                elif t == "text_card":
                    render_text_card(value, out)
                # NB: t may have flipped above, so re-check existence.
                if out.exists():
                    images.append((out, t))
                    scene_types.append(t)
                    scene_prompt_audit.append(f"[{t}] {value}")
            if not images:
                raise RuntimeError("no scenes rendered; aborting")
            print(f"[scenes] rendered {len(images)}/{len(scenes)}  cost-so-far=${total_cost:.4f}")

            # 5. TTS narration.
            audio_out = tdp / "voice.mp3"
            c = tts(plan["script"], audio_out); total_cost += c
            print(f"[tts] {audio_out.stat().st_size/1024:.1f} KB")

            # 6. ffmpeg assemble (scene-type aware).
            video_out = tdp / "final.mp4"
            assemble_video(images, audio_out, video_out, hook_title=plan.get("hook_title"))
            print(f"[ffmpeg] {video_out.stat().st_size/1024:.1f} KB → {style['duration_sec']}s target")

            # 7. Upload assets.
            draft_id_prefix = f"{today.isoformat()}-{row_kind}-{style_name}"
            for i, (p, _t) in enumerate(images):
                u = upload(p, f"{draft_id_prefix}/scene-{i:02d}.png", "image/png")
                image_urls.append(u)
            audio_url = upload(audio_out, f"{draft_id_prefix}/voice.mp3", "audio/mpeg")
            video_url = upload(video_out, f"{draft_id_prefix}/final.mp4", "video/mp4")

        # 8. Persist the draft. If this was a regen, update the existing
        # row in place so the admin's UI keeps showing the same card.
        with conn.cursor() as cur:
            payload = {
                "kind": row_kind,
                "trend": trend_text,
                "hook": plan.get("hook_title", ""),
                "script": plan["script"],
                "captions": psycopg2.extras.Json(plan.get("captions", {})),
                "scene_prompts": scene_prompt_audit,
                "image_urls": image_urls,
                "audio_url": audio_url,
                "video_url": video_url,
                "scheduled_for": today,
                "cost": round(total_cost, 4),
                "meta": psycopg2.extras.Json({
                    "scene_count": len(images),
                    "trend_chars": len(trend_text),
                    "style": style_name,
                    "regen_of": regen["id"] if regen else None,
                }),
                "style": style_name,
                "scene_types": scene_types,
            }
            if regen:
                cur.execute(
                    """
                    UPDATE public.marketing_drafts SET
                      trend_source = %(trend)s,
                      hook_title   = %(hook)s,
                      script       = %(script)s,
                      captions     = %(captions)s,
                      scene_prompts = %(scene_prompts)s,
                      image_urls   = %(image_urls)s,
                      audio_url    = %(audio_url)s,
                      video_url    = %(video_url)s,
                      scheduled_for = %(scheduled_for)s,
                      openai_cost_usd = %(cost)s,
                      generation_meta = %(meta)s,
                      style        = %(style)s,
                      scene_types  = %(scene_types)s,
                      requested_style = NULL,
                      status       = 'pending'
                    WHERE id = %(id)s
                    """,
                    {**payload, "id": regen["id"]},
                )
                draft_id = regen["id"]
            else:
                draft_id = insert_draft(cur, payload)
        conn.commit()
        print(f"[ok] draft {draft_id} {'regenerated' if regen else 'created'}. style={style_name} cost≈${total_cost:.4f}")
    except Exception as e:
        conn.rollback()
        print(f"[err] {e}")
        raise
    finally:
        conn.close()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True, choices=("daily", "weekly"))
    ap.add_argument("--style", default=None, help=f"Override style. One of: {', '.join(STYLE_LIBRARY.keys())}")
    ap.add_argument("--dry-run", action="store_true", help="Print the resolved plan + prompts; skip OpenAI/ffmpeg/upload/DB.")
    args = ap.parse_args()
    main(args.kind, style_override=args.style, dry_run=args.dry_run)
