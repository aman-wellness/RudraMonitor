#!/usr/bin/env python3
"""
AI-driven marketing content generator. Runs on the EC2 host on a systemd
timer (daily + weekly) and produces:

    daily  → 1 short_video draft (≤30s) + post captions for 4 platforms
    weekly → 1 long_video draft (≤5min) + post captions for 4 platforms

The whole pipeline uses ONE OpenAI API key (MARKETING_OPENAI_API_KEY env
var) and the host's ffmpeg binary. No third-party SaaS. End-to-end:

    1. searchTrends() — Responses API with web_search tool, picks today's
       most relevant employee-monitoring / remote-work trend.
    2. plan() — GPT-4o JSON mode produces:
         { hook, script, scene_prompts[], captions{linkedin, x, instagram, facebook} }
    3. generate_images() — DALL-E 3 per scene (5 for short, 20 for long).
    4. tts() — OpenAI TTS-1 mp3 narration of the script.
    5. assemble() — ffmpeg Ken Burns slideshow of scenes + voiceover + brand
       overlay → final.mp4.
    6. upload() — assets uploaded to marketing-media Supabase bucket.
    7. insert_draft() — row into marketing_drafts (status='pending') with
       URLs + cost telemetry, for super-admin review at /admin/marketing.

Idempotent on (scheduled_for, kind): skips if a row already exists for
today/this-week so re-runs on the timer (catch-up after EC2 reboot, etc.)
don't double-bill OpenAI.

Usage:
    generate.py --kind=daily
    generate.py --kind=weekly
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

# Required: the host's connection to Supabase + Postgres. Set in
# /etc/rudrans-marketing.env (see Implementation order #5).
SUPABASE_URL = os.environ.get("SUPABASE_URL",  "http://localhost:8000")
SR_KEY      = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PG_DSN      = os.environ.get("PG_DSN", "postgresql://postgres:postgres@localhost:5432/postgres")
BUCKET = "marketing-media"

if not SR_KEY:
    sys.exit("SUPABASE_SERVICE_ROLE_KEY not set")

# OpenAI key resolution: DB-first (integrations table row managed via
# /admin/integrations in the dashboard), env var fallback for back-compat.
# Resolved lazily inside main() so the DB read can short-circuit if the
# `enabled` flag is off — saves one query when paused.
OPENAI_KEY: str = ""
OPENAI_API = "https://api.openai.com/v1"

# --- OpenAI helpers --------------------------------------------------------

# Price table for cost telemetry. Update when OpenAI shifts rates.
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
    """Responses API with web_search tool, falls back to chat-completions."""
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
            "model": "dall-e-3",
            "prompt": prompt[:3500],  # DALL-E prompt cap is 4000
            "size": size,
            "n": 1,
            "response_format": "b64_json",
            "quality": "standard",
        },
        timeout=180,
    )
    if not r.ok:
        # Soft fail — log + return blank cost so the pipeline continues with
        # the scenes that did succeed.
        print(f"[warn] DALL-E image failed for prompt {prompt[:60]!r}: {r.status_code} {r.text[:200]}")
        return 0.0
    import base64
    b64 = r.json()["data"][0]["b64_json"]
    out_path.write_bytes(base64.b64decode(b64))
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

# --- ffmpeg assembly -------------------------------------------------------

def assemble_video(image_paths: list[Path], audio_path: Path, out_path: Path, hook_title: str | None = None) -> None:
    """Slideshow with Ken Burns + audio + optional title overlay on frame 1."""
    if not image_paths:
        raise RuntimeError("no images to assemble")
    # Per-scene duration = audio duration / count, with minimum 2s + max 6s.
    probe = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
    ).decode().strip()
    audio_secs = max(float(probe), 1.0)
    per = max(2.0, min(6.0, audio_secs / len(image_paths)))

    # Build a concat-friendly intermediate video for each image with zoompan
    # (Ken Burns) effect. Output 1080p 30fps yuv420p so it plays on every
    # social platform.
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        clip_paths: list[Path] = []
        for i, img in enumerate(image_paths):
            clip = td_path / f"clip-{i:02d}.mp4"
            # zoompan: zoom from 1.0 → 1.15 over the clip, slow pan.
            zoom_filter = (
                "zoompan="
                f"z='min(zoom+0.0015,1.15)':"
                f"d={int(per*30)}:"
                "x='iw/2-(iw/zoom/2)':"
                "y='ih/2-(ih/zoom/2)':"
                "s=1080x1080:fps=30"
            )
            text_overlay = ""
            if i == 0 and hook_title:
                # Title card on first scene only, 1.5s.
                safe = hook_title.replace("'", "\\'").replace(":", "\\:")
                text_overlay = (
                    f",drawtext=text='{safe}':"
                    "fontcolor=white:fontsize=44:"
                    "box=1:boxcolor=black@0.6:boxborderw=20:"
                    "x=(w-text_w)/2:y=h-180:"
                    "enable='between(t,0,2.5)'"
                )
            vf = zoom_filter + text_overlay
            subprocess.run(
                ["ffmpeg", "-y", "-loop", "1", "-i", str(img),
                 "-vf", vf,
                 "-t", f"{per}",
                 "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "fast",
                 "-an", str(clip)],
                check=True, capture_output=True,
            )
            clip_paths.append(clip)

        # Concat list file.
        list_file = td_path / "concat.txt"
        list_file.write_text("\n".join(f"file '{p}'" for p in clip_paths))
        silent_video = td_path / "video.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
             "-c", "copy", str(silent_video)],
            check=True, capture_output=True,
        )
        # Mux audio.
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(silent_video), "-i", str(audio_path),
             "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
             "-shortest", str(out_path)],
            check=True, capture_output=True,
        )

# --- Supabase Storage ------------------------------------------------------

def upload(local: Path, remote_path: str, content_type: str) -> str:
    """PUT to Supabase Storage. Returns the public URL (bucket is private,
    but the URL still resolves with a signed-URL request later)."""
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{remote_path}"
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
        # Fall back to POST if the object doesn't exist yet.
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
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{remote_path}"

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
    """DB-first lookup of the marketing OpenAI key. Admin manages this via
    /admin/integrations in the dashboard (key=MARKETING_OPENAI_API_KEY).
    Falls back to the MARKETING_OPENAI_API_KEY env var for back-compat
    with pre-DB-lookup deployments."""
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

def insert_draft(cur, draft: dict[str, Any]) -> str:
    # Service-role bypasses RLS so the insert goes through despite the
    # marketing_drafts_block_insert deny policy.
    cur.execute(
        """
        INSERT INTO marketing_drafts (
          kind, status, trend_source, hook_title, script, captions,
          scene_prompts, image_urls, audio_url, video_url, scheduled_for,
          openai_cost_usd, generation_meta
        ) VALUES (
          %(kind)s, 'pending', %(trend)s, %(hook)s, %(script)s, %(captions)s,
          %(scene_prompts)s, %(image_urls)s, %(audio_url)s, %(video_url)s,
          %(scheduled_for)s, %(cost)s, %(meta)s
        ) RETURNING id
        """,
        draft,
    )
    return cur.fetchone()["id"]

# --- Main ------------------------------------------------------------------

def main(kind: str) -> None:
    if kind not in ("daily", "weekly"):
        sys.exit(f"unknown kind {kind!r}")
    is_long = kind == "weekly"
    scene_count = 20 if is_long else 5
    target_sec = 300 if is_long else 30
    today = dt.date.today()

    total_cost = 0.0

    conn = psycopg2.connect(PG_DSN, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            row_kind = "long_video" if is_long else "short_video"
            if already_generated_today(cur, row_kind, today):
                print(f"already generated {kind} for {today}, skipping")
                return
            s = load_settings(cur)
            # Hard stop — super-admin flipped `enabled` to false in
            # marketing_settings (or the migration default if seeded
            # off). No OpenAI calls, no DALL-E, no ffmpeg, no cost.
            if not s.get("enabled", True):
                print(f"marketing_settings.enabled = false, skipping {kind} run (no OpenAI calls).")
                return
            # Resolve the OpenAI key from the integrations table (admin
            # manages this in /admin/integrations). Failing here is loud
            # and gives the admin the exact place to fix it.
            global OPENAI_KEY
            OPENAI_KEY = load_openai_key(cur)
            print(f"openai key loaded ({len(OPENAI_KEY)} chars, prefix {OPENAI_KEY[:7]}…)")

        # 1. Trend search.
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

        # 2. Plan + script + captions JSON.
        system = (
            "You are a senior B2B SaaS content marketer. You write hooks that "
            "make IT managers stop scrolling. You never use corporate jargon. "
            "Output STRICT JSON only."
        )
        user = f"""
Brand voice: {s['brand_voice']}
Value props: {", ".join(s['value_props'])}
Target audience: {s['target_audience']}
Content style: {s['content_style']}
Visual style for image generation: {s['visual_style']}

Today's trend to anchor on:
{trend_text}

Produce a {'5-minute (target {} scenes)'.format(scene_count) if is_long else '30-second (5 scenes)'} marketing video script + social-media captions.

JSON schema:
{{
  "hook_title": "string — 6-8 word hook overlaid on the first frame",
  "script": "string — narrator script. {'~750 words' if is_long else '~70 words'}. Conversational. No 'um's. ONE big idea.",
  "scene_prompts": [
    "string — DALL-E 3 image prompt for scene 1. Include the visual style. Cinematic but flat. No text in the image.",
    "...",
    "string — scene {scene_count}"
  ],
  "captions": {{
    "linkedin": "string — 1200 chars max, ~3 short paragraphs, opens with the hook",
    "x":        "string — 270 chars max, punchy",
    "instagram":"string — 1500 chars max, 5-10 relevant hashtags at the end",
    "facebook": "string — 1500 chars max, conversational"
  }}
}}

Exactly {scene_count} scene_prompts. The first frame's hook_title must appear ONLY in the title overlay (not in the image)."""

        plan, c = json_chat(system, user); total_cost += c
        if not isinstance(plan.get("scene_prompts"), list) or len(plan["scene_prompts"]) == 0:
            raise RuntimeError(f"plan returned no scene_prompts: {plan}")
        # Trim/pad scene list to expected count so ffmpeg pacing works.
        plan["scene_prompts"] = plan["scene_prompts"][:scene_count]
        print(f"[plan] hook={plan.get('hook_title','?')!r}  scenes={len(plan['scene_prompts'])}")

        # 3. Images.
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            image_paths: list[Path] = []
            image_urls: list[str] = []
            for i, prompt in enumerate(plan["scene_prompts"]):
                out = tdp / f"scene-{i:02d}.png"
                styled_prompt = f"{prompt}. Visual style: {s['visual_style']}."
                c = gen_image(styled_prompt, out)
                total_cost += c
                if out.exists():
                    image_paths.append(out)
            if not image_paths:
                raise RuntimeError("no images generated; aborting")
            print(f"[img] generated {len(image_paths)}/{scene_count}")

            # 4. TTS narration.
            audio_out = tdp / "voice.mp3"
            c = tts(plan["script"], audio_out)
            total_cost += c
            print(f"[tts] {audio_out.stat().st_size/1024:.1f} KB")

            # 5. ffmpeg assemble.
            video_out = tdp / "final.mp4"
            assemble_video(image_paths, audio_out, video_out, hook_title=plan.get("hook_title"))
            print(f"[ffmpeg] {video_out.stat().st_size/1024:.1f} KB → {target_sec}s target")

            # 6. Upload.
            draft_id_prefix = f"{today.isoformat()}-{row_kind}"
            for i, p in enumerate(image_paths):
                u = upload(p, f"{draft_id_prefix}/scene-{i:02d}.png", "image/png")
                image_urls.append(u)
            audio_url = upload(audio_out, f"{draft_id_prefix}/voice.mp3", "audio/mpeg")
            video_url = upload(video_out, f"{draft_id_prefix}/final.mp4", "video/mp4")

        # 7. Insert draft row.
        with conn.cursor() as cur:
            draft_id = insert_draft(cur, {
                "kind": row_kind,
                "trend": trend_text,
                "hook": plan.get("hook_title", ""),
                "script": plan["script"],
                "captions": psycopg2.extras.Json(plan.get("captions", {})),
                "scene_prompts": plan["scene_prompts"],
                "image_urls": image_urls,
                "audio_url": audio_url,
                "video_url": video_url,
                "scheduled_for": today,
                "cost": round(total_cost, 4),
                "meta": psycopg2.extras.Json({
                    "scene_count": len(image_paths),
                    "trend_chars": len(trend_text),
                }),
            })
        conn.commit()
        print(f"[ok] draft {draft_id} created. cost ≈ ${total_cost:.4f}")
    except Exception as e:
        conn.rollback()
        print(f"[err] {e}")
        raise
    finally:
        conn.close()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True, choices=("daily", "weekly"))
    args = ap.parse_args()
    main(args.kind)
