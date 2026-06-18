# Self-hosted invoice OCR + structured extraction.
#
# Replaces a paid Anthropic Claude call with a local pipeline:
#   1. PDF  → pdftotext -layout  (falls back to pdftoppm + tesseract for
#                                 image-only / scanned PDFs)
#   2. JPG/PNG/WEBP → tesseract directly (eng + hin trained data)
#   3. OCR text → Ollama (small instruct model) → strict JSON
#   4. Best-effort post-processing (dates → ISO, anti-hallucination on
#      invoice_number — null it if the model invented one that isn't in
#      the OCR text).
#
# Called by supabase/functions/invoice-extract/index.ts on the same EC2
# box via the docker bridge. Auth: shared bearer token (SIDECAR_TOKEN),
# matching what the edge function has in its env.

import base64
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

SIDECAR_TOKEN = os.environ["SIDECAR_TOKEN"]

# We support two LLM backends, picked at runtime by env:
#   - Groq cloud (FAST, free tier, ~1s end-to-end): set GROQ_API_KEY.
#     Uses OpenAI-compatible /chat/completions with response_format=json.
#   - Ollama local fallback (SLOW, ~60s on CPU): used if GROQ_API_KEY is
#     unset. Keeps the box self-sufficient when the customer pulls the
#     cloud-call plug.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")

PDF_MIN_TEXT_CHARS = 50           # below this → assume scanned, OCR fallback
OCR_MAX_PAGES = 5                 # don't OCR 100-page docs
LLM_TIMEOUT_S = 30                # Groq usually answers in <2s; 30s
                                  # is the patience we'd ever wait for a
                                  # single invoice. Ollama path overrides
                                  # below.
OLLAMA_TIMEOUT_S = 180            # CPU inference is slow; first-call model
                                  # load alone can eat 15-30s on a 3b model
OCR_TEXT_CAP_CHARS = 4000         # context the LLM ingests — header+footer
                                  # of a typical invoice fits easily
SYSTEM_PROMPT = """Extract structured invoice fields from the invoice text below and output ONE JSON object — no prose, no markdown fence.

Shape (every field optional; emit null if not on the document):
{
  "invoice_number": "INV-2025-0042" | null,
  "issue_date":     "YYYY-MM-DD"  | null,
  "period_start":   "YYYY-MM-DD"  | null,
  "period_end":     "YYYY-MM-DD"  | null,
  "due_date":       "YYYY-MM-DD"  | null,
  "amount":         <number>      | null,
  "currency":       "USD"|"INR"|"EUR"... | null,
  "status":         "paid"|"pending"|"overdue"|"failed"|"refunded"|"draft" | null,
  "vendor_name":    "Adobe Inc."  | null,
  "vendor_domain":  "adobe.com"   | null,
  "notes":          "1-line summary if helpful" | null
}

Rules:
- Dates must be ISO YYYY-MM-DD. Convert "Sep 14, 2025" → "2025-09-14".
- Amount: total/grand-total numeric, no currency symbol. If multiple lines, pick the final due amount.
- Currency: ISO 4217 code (INR, USD, etc.).
- vendor_domain: the sender / company's web domain (e.g. "razorpay.com"), used downstream to match against the customer's stored credentials.
- If the document is clearly not an invoice (receipt, statement, marketing PDF), return all-null fields and put a note explaining what it actually is.
- DO NOT invent values. If a field isn't clearly in the text, emit null."""

app = FastAPI()


class ExtractIn(BaseModel):
    mime_type: str
    data_b64: str


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "backend": "groq" if GROQ_API_KEY else "ollama",
        "model": GROQ_MODEL if GROQ_API_KEY else OLLAMA_MODEL,
    }


@app.post("/extract-invoice")
async def extract_invoice(payload: ExtractIn, authorization: str = Header("")):
    # ── Auth ───────────────────────────────────────────────────────────
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if token != SIDECAR_TOKEN:
        raise HTTPException(401, "invalid sidecar token")

    mime = payload.mime_type.lower()
    try:
        raw = base64.b64decode(payload.data_b64, validate=False)
    except Exception as e:
        raise HTTPException(400, f"base64 decode: {e}")

    # ── OCR / text extract ─────────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "in.bin"
        src.write_bytes(raw)

        text = ""
        source = ""
        if mime == "application/pdf":
            text = _pdf_to_text(src, tmp)
            source = "pdftotext"
            if len(text.strip()) < PDF_MIN_TEXT_CHARS:
                text = _pdf_ocr(src, tmp)
                source = "pdf-tesseract"
        elif mime in ("image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"):
            text = _image_ocr(src)
            source = "image-tesseract"
        else:
            raise HTTPException(400, f"unsupported mime {mime}")

    text = text.strip()
    if not text:
        return {
            "extracted": _empty(),
            "ocr_chars": 0,
            "source": source,
            "note": "no text extracted",
        }

    # ── Stage 1: regex-only extract (sub-second) ───────────────────────
    # Most B2B invoices have predictable field patterns. If regex hits
    # ALL critical fields (invoice_number + amount + at least one date),
    # we skip the LLM entirely and respond in <1s — that covers the
    # common Adobe / AWS / Razorpay / Stripe / Zoho style. Vendor name
    # is best-effort here; LLM does it better on free-form layouts.
    regex_parsed = _regex_extract(text)
    if _regex_sufficient(regex_parsed):
        regex_parsed = _post_process(regex_parsed, text)
        return {
            "extracted": regex_parsed,
            "ocr_chars": len(text),
            "source": source,
            "engine": "regex",
        }

    # ── Stage 2: trim then LLM fallback (~40-60s on CPU Ollama) ────────
    # Got here because regex missed something critical. Now we pay the
    # LLM tax — small models choke on long contexts, so trim head+tail.
    if len(text) > OCR_TEXT_CAP_CHARS:
        head = int(OCR_TEXT_CAP_CHARS * 2 / 3)
        tail = OCR_TEXT_CAP_CHARS - head
        text = text[:head] + "\n...\n" + text[-tail:]

    # Gap-fill: ask the LLM ONLY for the fields regex couldn't fill.
    # On a 2-vCPU CPU, a full 11-field JSON extract takes ~50s because
    # prompt processing is the dominant cost (~10 tok/s). A scoped
    # request asking for ~2 fields with a 60-token cap finishes in
    # 3-8 sec on qwen2.5:1.5b. The reduction is mostly in num_predict
    # AND prompt size — we don't repeat fields we already know.
    missing = [k for k, v in regex_parsed.items() if v in (None, "")]
    if not missing:
        # Pathological: regex didn't pass _regex_sufficient but everything
        # ended up filled. Just use regex.
        parsed = _post_process(regex_parsed, text)
        return {
            "extracted": parsed,
            "ocr_chars": len(text),
            "source": source,
            "engine": "regex",
        }

    llm_parsed, engine_tag = await _run_llm(text, missing=missing, known=regex_parsed)

    # Merge: regex wins where it had a value (no hallucination), LLM
    # fills only the gaps it was asked about.
    parsed = _merge_extracts(regex_parsed, llm_parsed)
    engine = f"regex+{engine_tag}"

    parsed = _post_process(parsed, text)
    return {
        "extracted": parsed,
        "ocr_chars": len(text),
        "source": source,
        "engine": engine,
    }


def _post_process(parsed: dict, text: str) -> dict:
    """Anti-hallucination + enum normalisation. Applied regardless of
    whether the values came from regex or LLM."""
    # invoice_number must appear verbatim in OCR (small models hallucinate)
    inv_no = (parsed.get("invoice_number") or "").strip()
    if inv_no and inv_no.lower() not in text.lower():
        if not any(part.lower() in text.lower() for part in inv_no.split() if len(part) >= 4):
            parsed["invoice_number"] = None

    if isinstance(parsed.get("status"), str):
        parsed["status"] = parsed["status"].lower()
        if parsed["status"] not in {"paid", "pending", "overdue", "failed", "refunded", "draft"}:
            parsed["status"] = None

    notes = (parsed.get("notes") or "").strip()
    if notes in {"1-line summary if helpful", "null", "None", ""}:
        parsed["notes"] = None
    return parsed


def _merge_extracts(a: dict, b: dict) -> dict:
    """Take a's value if non-null, else fall back to b's value."""
    out = _empty()
    for k in out:
        out[k] = a.get(k) if a.get(k) not in (None, "") else b.get(k)
    return out


# ── Regex-only extract ─────────────────────────────────────────────────

_RX_INV_NO = re.compile(
    r"(?:invoice|bill|receipt)\s*(?:no\.?|number|#|num)\s*[:#]?\s*"
    r"([A-Z0-9][A-Z0-9\-\_/]{2,30})",
    re.IGNORECASE,
)
_RX_INV_NO_FALLBACK = re.compile(r"\b(INV[\-_]?[A-Z0-9\-]{3,25})\b", re.IGNORECASE)

# Dates — try ISO and a few common locale forms. We capture each match
# and label it by the preceding word (issue/due/period/etc.) below.
_RX_DATE_ISO = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_RX_DATE_SLASH = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{2,4})\b")
_RX_DATE_TEXT = re.compile(
    r"\b(\d{1,2}\s+"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4})\b",
    re.IGNORECASE,
)
_RX_DATE_TEXT_REV = re.compile(
    r"\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"
    r"\s+\d{1,2},?\s+\d{2,4})\b",
    re.IGNORECASE,
)
_MONTH_NUM = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
)}

_RX_AMOUNT = re.compile(
    r"(?:total(?:\s+(?:due|amount|payable))?|amount\s+due|grand\s+total|"
    r"balance(?:\s+due)?)\s*[:\-]?\s*"
    r"(?:[₹$€£¥]|USD|INR|EUR|GBP|JPY|AED|SGD|CAD|AUD)?\s*"
    r"([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.[0-9]{1,2})?)",
    re.IGNORECASE,
)

_CURRENCY_SYMBOL = {"₹": "INR", "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
_RX_CURRENCY_CODE = re.compile(r"\b(USD|INR|EUR|GBP|JPY|AED|SGD|CAD|AUD)\b")

# Two-pass match: first look near a "Status:" / "Payment Status:" label
# (high confidence), only then fall back to bare-word scan (low confidence,
# easily fooled by "Due Date" → matches "due").
_RX_STATUS_LABELLED = re.compile(
    r"(?:payment\s+)?status\s*[:\-]?\s*"
    r"(paid|pending|overdue|failed|refunded|draft|due|unpaid|completed|settled)",
    re.IGNORECASE,
)
_RX_STATUS_FREE = re.compile(
    r"\b(paid|overdue|failed|refunded|completed|settled)\b",
    re.IGNORECASE,
)
_STATUS_NORMALISE = {"due": "pending", "unpaid": "pending", "completed": "paid", "settled": "paid"}

_RX_DOMAIN = re.compile(r"\b([a-z0-9][a-z0-9\-]*\.(?:com|in|io|co|net|org|ai|tech|cloud))\b", re.IGNORECASE)
_DOMAIN_BLACKLIST = {  # Common red-herrings on invoices that aren't the vendor.
    "gmail.com", "outlook.com", "yahoo.com", "hotmail.com",
    "example.com", "company.com",
}


def _to_iso_date(s: str) -> str | None:
    s = s.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
        # Heuristic: if first part > 12, it's day-first; if second > 12, month-first.
        # Default to day-first (Indian/EU convention) — Razorpay, Zoho, etc.
        if d > 12 and mo <= 12:
            day, month = d, mo
        elif mo > 12 and d <= 12:
            day, month = mo, d
        else:
            day, month = d, mo
        if y < 100:
            y += 2000
        try:
            return f"{y:04d}-{month:02d}-{day:02d}"
        except Exception:
            return None
    m = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{2,4})", s)
    if m:
        day, mon, y = int(m[1]), m[2][:3].lower(), int(m[3])
        if mon in _MONTH_NUM:
            if y < 100:
                y += 2000
            return f"{y:04d}-{_MONTH_NUM[mon]:02d}-{day:02d}"
    m = re.fullmatch(r"([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})", s)
    if m:
        mon, day, y = m[1][:3].lower(), int(m[2]), int(m[3])
        if mon in _MONTH_NUM:
            if y < 100:
                y += 2000
            return f"{y:04d}-{_MONTH_NUM[mon]:02d}-{day:02d}"
    return None


def _find_labelled_date(text: str, label_words: list[str]) -> str | None:
    """Find a date near one of the label words (within 60 chars)."""
    lines = text.splitlines()
    # Try line-local: a label word and a date on the same logical line.
    for line in lines:
        low = line.lower()
        if any(w in low for w in label_words):
            for rx in (_RX_DATE_ISO, _RX_DATE_TEXT, _RX_DATE_TEXT_REV, _RX_DATE_SLASH):
                m = rx.search(line)
                if m:
                    iso = _to_iso_date(m.group(1))
                    if iso:
                        return iso
    # Try same-window across the whole text (e.g. "Due Date\n2025-10-12")
    for w in label_words:
        for m in re.finditer(rx_word(w), text, re.IGNORECASE):
            window = text[m.end(): m.end() + 80]
            for rx in (_RX_DATE_ISO, _RX_DATE_TEXT, _RX_DATE_TEXT_REV, _RX_DATE_SLASH):
                dm = rx.search(window)
                if dm:
                    iso = _to_iso_date(dm.group(1))
                    if iso:
                        return iso
    return None


def rx_word(w: str) -> str:
    return r"\b" + re.escape(w) + r"\b"


def _regex_extract(text: str) -> dict:
    out = _empty()

    # Invoice number — labelled first, fallback to "INV-…" anywhere.
    m = _RX_INV_NO.search(text) or _RX_INV_NO_FALLBACK.search(text)
    if m:
        cand = m.group(1).strip(" -_:.")
        # Must contain a digit; pure-word matches (e.g. "Number") are noise.
        if re.search(r"\d", cand):
            out["invoice_number"] = cand

    # Dates — issue, due, period.
    out["issue_date"] = _find_labelled_date(
        text, ["issue date", "invoice date", "bill date", "date of issue", "date"]
    )
    out["due_date"] = _find_labelled_date(text, ["due date", "payable by", "pay by"])
    # NOTE: don't use bare "from"/"to" as labels — they trigger on
    # "Bill to:", "Sent from:" etc. and grab the wrong date. The
    # dedicated period regex below ("Period: X to Y") handles the
    # common case; explicit labels only here.
    out["period_start"] = _find_labelled_date(text, ["period start", "service from", "billing period start"])
    out["period_end"] = _find_labelled_date(text, ["period end", "service to", "billing period end"])

    # Amount — "Total: 1,234.56" / "Amount Due: ₹500" — take the LAST hit
    # (totals are typically near the footer, after subtotals).
    amounts = _RX_AMOUNT.findall(text)
    if amounts:
        raw = amounts[-1].replace(",", "").replace(" ", "")
        try:
            out["amount"] = float(raw)
        except Exception:
            pass

    # Currency — symbol near the amount OR an ISO code anywhere.
    for sym, code in _CURRENCY_SYMBOL.items():
        if sym in text:
            out["currency"] = code
            break
    if not out["currency"]:
        m = _RX_CURRENCY_CODE.search(text)
        if m:
            out["currency"] = m.group(1).upper()

    # Status — labelled first (high confidence), then free-text fallback
    # that ONLY accepts unambiguous keywords ("paid", "overdue", etc.)
    # because "due" appears in "Due Date" labels and would mis-match.
    m = _RX_STATUS_LABELLED.search(text) or _RX_STATUS_FREE.search(text)
    if m:
        s = m.group(1).lower()
        out["status"] = _STATUS_NORMALISE.get(s, s)

    # Period — "Period: 2026-06-10 to 2026-07-10" / "Service period: …"
    period_m = re.search(
        r"(?:billing\s+)?period\s*[:\-]?\s*"
        r"([\d/\-A-Za-z, ]{6,20}?)\s+(?:to|-|–|—|through)\s+"
        r"([\d/\-A-Za-z, ]{6,20})",
        text, re.IGNORECASE,
    )
    if period_m:
        ps = _to_iso_date(period_m.group(1).strip())
        pe = _to_iso_date(period_m.group(2).strip())
        if ps and not out["period_start"]:
            out["period_start"] = ps
        if pe and not out["period_end"]:
            out["period_end"] = pe

    # Vendor domain — first non-blacklisted domain in the document.
    for m in _RX_DOMAIN.finditer(text):
        dom = m.group(1).lower()
        if dom not in _DOMAIN_BLACKLIST:
            out["vendor_domain"] = dom
            break

    return out


def _regex_sufficient(parsed: dict) -> bool:
    """Return True if regex has enough confidence to skip the LLM.

    Critical fields: invoice_number + amount + at least one date.
    Vendor name regex is unreliable; leave it to the LLM unless we got
    a domain already (domain alone is enough for credential matching).
    """
    has_id = bool(parsed.get("invoice_number"))
    has_amount = parsed.get("amount") is not None
    has_date = any(parsed.get(k) for k in ("issue_date", "due_date", "period_start"))
    return has_id and has_amount and has_date


# ── Helpers ────────────────────────────────────────────────────────────

def _empty() -> dict:
    return {
        "invoice_number": None, "issue_date": None, "period_start": None,
        "period_end": None, "due_date": None, "amount": None,
        "currency": None, "status": None, "vendor_name": None,
        "vendor_domain": None, "notes": None,
    }


def _pdf_to_text(pdf: Path, tmp: Path) -> str:
    out = tmp / "out.txt"
    r = subprocess.run(
        ["pdftotext", "-layout", "-nopgbrk", str(pdf), str(out)],
        capture_output=True, timeout=30,
    )
    if r.returncode != 0:
        return ""
    return out.read_text(errors="ignore") if out.exists() else ""


def _pdf_ocr(pdf: Path, tmp: Path) -> str:
    """Rasterise PDF pages to PNG, then OCR each."""
    prefix = tmp / "page"
    subprocess.run(
        ["pdftoppm", "-r", "200", "-png", "-l", str(OCR_MAX_PAGES), str(pdf), str(prefix)],
        capture_output=True, timeout=60,
    )
    chunks = []
    for png in sorted(tmp.glob("page-*.png")):
        chunks.append(_image_ocr(png))
    return "\n\n".join(chunks)


def _image_ocr(img: Path) -> str:
    r = subprocess.run(
        ["tesseract", str(img), "-", "-l", "eng+hin"],
        capture_output=True, timeout=45,
    )
    if r.returncode != 0:
        return ""
    return r.stdout.decode("utf-8", errors="ignore")


async def _run_llm(text: str, missing: list[str] | None = None,
                   known: dict | None = None) -> tuple[dict, str]:
    """Route to Groq first (cloud, ~1s) with Ollama fallback (local,
    ~12s on CPU). Any Groq failure — rate-limit, 5xx, network — silently
    cascades. Returns (extracted, engine_tag).

    The fallback is best-effort: we log to stderr but don't surface
    Groq errors to the user because the local path still produces a
    valid extraction. Customer never sees "Groq down" in the UI.
    """
    if GROQ_API_KEY:
        try:
            parsed = await _groq_extract(text, missing=missing, known=known)
            return parsed, "groq"
        except Exception as e:
            # Log and continue. Common causes: 429 rate-limit (free tier
            # is 30 req/min), transient 5xx, timeout. Ollama still works.
            print(f"[sidecar] groq failed, falling back to ollama: {e}", flush=True)
    parsed = await _ollama_extract(text, missing=missing, known=known)
    return parsed, "ollama"


def _gap_fill_prompt(text: str, missing: list[str], known: dict) -> tuple[str, str]:
    """Build a scoped extraction prompt that asks for ONLY the missing
    fields, telling the model what's already known so it doesn't waste
    tokens re-emitting them. Returns (system, user) message pair."""
    known_pruned = {k: v for k, v in (known or {}).items() if v not in (None, "")}
    sys_msg = (
        "Extract invoice fields from the text below and output ONE JSON "
        "object — no prose, no markdown fence. Only emit the fields in "
        f"`missing`; null if a field genuinely isn't on the document. "
        "Dates must be ISO YYYY-MM-DD. Amounts are numeric (no currency "
        "symbol). Status enum: paid|pending|overdue|failed|refunded|draft. "
        "Do NOT invent values."
    )
    usr_msg = (
        f"Already known (don't repeat):\n{json.dumps(known_pruned)}\n\n"
        f"Missing fields to find: {json.dumps(missing)}\n\n"
        f"Invoice text:\n{text}\n\n"
        f"Return JSON containing only the missing-field keys."
    )
    return sys_msg, usr_msg


async def _groq_extract(text: str, missing: list[str] | None = None,
                        known: dict | None = None) -> dict:
    """Send OCR text to Groq's OpenAI-compatible chat API.

    Free tier: 30 req/min on llama-3.1-8b-instant, 750+ tokens/sec
    throughput, sub-second p50 latency. JSON-mode guaranteed via
    response_format={"type": "json_object"}.
    """
    if missing:
        sys_msg, usr_msg = _gap_fill_prompt(text, missing, known or {})
    else:
        sys_msg = SYSTEM_PROMPT
        usr_msg = f"Invoice text:\n\n{text}\n\nReturn the JSON object now."
    body = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": usr_msg},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "max_tokens": 512,
    }
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT_S) as client:
        r = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            json=body, headers=headers,
        )
    if r.status_code != 200:
        # Plain RuntimeError (NOT HTTPException) so the _run_llm
        # wrapper can catch it and fall back to local Ollama instead
        # of returning a 502 to the customer.
        raise RuntimeError(f"groq {r.status_code}: {r.text[:300]}")
    payload = r.json()
    raw_out = payload["choices"][0]["message"]["content"]
    return _normalise_extract(raw_out)


def _normalise_extract(raw_out: str) -> dict:
    parsed = _parse_json_blob(raw_out)
    if parsed is None:
        empty = _empty()
        empty["notes"] = f"model output unparseable: {raw_out[:200]}"
        return empty
    out = _empty()
    for k in list(out.keys()):
        if k in parsed:
            out[k] = parsed[k]
    if isinstance(out["amount"], str):
        m = re.search(r"-?\d+(?:[\.,]\d+)?", out["amount"].replace(",", ""))
        out["amount"] = float(m.group(0)) if m else None
    return out


async def _ollama_extract(text: str, missing: list[str] | None = None,
                          known: dict | None = None) -> dict:
    """Send OCR text to Ollama with `format: json` for guaranteed-valid JSON.

    Two modes:
      - Full extract (missing=None): asks for all 11 fields. ~50s on
        llama3.2:3b CPU. Used as last resort.
      - Gap-fill (missing=[...]): asks ONLY for the listed fields.
        ~3-8s on qwen2.5:1.5b. Used by the regex+LLM pipeline.

    num_predict / num_ctx are tuned tight — small models on CPU are
    dominated by prompt processing latency, so context size matters
    more than output cap. 2048 ctx fits an invoice + the scoped prompt.
    """
    if missing:
        sys_msg, usr_msg = _gap_fill_prompt(text, missing, known or {})
        # Small models tend to re-emit known fields even when told not to,
        # so size num_predict for the worst case (all 11 fields in JSON =
        # ~200 tokens) rather than the ideal case. Truncation here means
        # a parse failure and a lost extraction — costs more than the
        # extra 1-2s of generation.
        num_predict = 220
        num_ctx = 2048
    else:
        sys_msg = SYSTEM_PROMPT
        usr_msg = f"Invoice text:\n\n{text}\n\nReturn the JSON object now."
        num_predict = 256
        num_ctx = 4096
    body = {
        "model": OLLAMA_MODEL,
        "prompt": usr_msg,
        "system": sys_msg,
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": num_predict,
            "num_ctx": num_ctx,
        },
    }
    async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_S) as client:
        r = await client.post(f"{OLLAMA_URL}/api/generate", json=body)
    if r.status_code != 200:
        raise HTTPException(502, f"ollama {r.status_code}: {r.text[:300]}")
    payload = r.json()
    raw_out = payload.get("response", "")
    return _normalise_extract(raw_out)


def _parse_json_blob(s: str) -> dict | None:
    s = s.strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b < 0 or b <= a:
        return None
    try:
        return json.loads(s[a : b + 1])
    except Exception:
        return None
