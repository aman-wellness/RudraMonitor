// Claude-driven action loop. We send the LLM a compact state package
// (screenshot + aria DOM snapshot + last action result + goal) and parse
// one Action JSON object back. The action vocabulary is fixed (see
// browser.ts) so the LLM can't ask the worker to do anything dangerous.

import Anthropic from "@anthropic-ai/sdk";
import type { Action } from "./browser.js";
import { getIntegration } from "./supabase.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

// Lazy-init the Anthropic client. The API key lives in the Supabase
// `integrations` table (managed via /admin/integrations), NOT in the
// worker's .env — that way super-admin can rotate it from the dashboard
// without SSH. Cached after first fetch; worker restart picks up changes.
let _client: Anthropic | null = null;
async function getClient(): Promise<Anthropic> {
  if (_client) return _client;
  // Fallback to env for local dev. Prod always uses the portal value.
  const envKey = process.env.ANTHROPIC_API_KEY;
  const portalKey = envKey && envKey !== "PLACEHOLDER_WAITING_FOR_USER"
    ? envKey
    : await getIntegration("ANTHROPIC_API_KEY");
  if (!portalKey) {
    throw new Error("ANTHROPIC_API_KEY missing — set it in /admin/integrations → AI Providers");
  }
  _client = new Anthropic({ apiKey: portalKey });
  return _client;
}

const SYSTEM = `You drive a Chromium browser to download the LATEST billing invoice PDF for a given SaaS platform.

You receive: a screenshot, an aria snapshot of the DOM, and the result of your previous action.

Output EXACTLY one JSON object with one of these shapes — nothing else, no prose, no markdown fence:

{ "type": "goto", "url": "https://..." }
{ "type": "click", "selector": "css selector or text=…" }
{ "type": "type", "selector": "...", "value": "..." }
{ "type": "select", "selector": "...", "value": "..." }
{ "type": "press", "key": "Enter" }
{ "type": "wait_ms", "ms": 1500 }
{ "type": "wait_for", "selector": "...", "ms": 10000 }
{ "type": "needs_otp", "prompt": "AWS is asking for a 6-digit Authenticator code" }
{ "type": "download", "selector": "a:has-text('Download')" }
{ "type": "extract_invoice", "fields": { "invoice_number": "...", "issue_date": "YYYY-MM-DD", "amount": 1234.56, "currency": "INR", "status": "paid", "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD" } }
{ "type": "done_success" }
{ "type": "done_failed", "reason": "couldn't find invoice page" }
{ "type": "done_needs_human", "reason": "CAPTCHA blocking login" }

Rules:
- Prefer text= or [aria-label="..."] selectors over fragile CSS class chains.
- When you see an OTP / authenticator / "code we sent" screen, emit needs_otp. Don't try to guess the code.
- Before download, if you see invoice metadata on the page, emit extract_invoice first.
- After the download succeeds, emit done_success.
- If you've been on the same page for 3+ turns with no progress, emit done_failed.
- Never enter credentials more than once; if login appears stuck, emit done_failed.

Smart URL fallback:
- If the given login_url is a marketing site (www.adobe.com, www.zoom.us, www.slack.com), navigate to the actual account/billing URL instead. Common patterns:
    Adobe   → https://account.adobe.com/account
    Zoom    → https://us05web.zoom.us/billing
    Slack   → https://<workspace>.slack.com/admin/billing
    Microsoft → https://admin.microsoft.com/AdminPortal/Home#/billing
    Google Workspace → https://admin.google.com/ac/billing
- Marketing homepages rarely show login buttons that work for billing — go direct to the billing path.

Bot detection:
- If you see "Press & Hold", "Verify you are human", reCAPTCHA, FunCaptcha, Cloudflare challenge, or any image-puzzle:
    emit { "type": "done_needs_human", "reason": "<specific challenge type> blocking login" }
- Don't try to bypass — bot detection adapts to bypasses and gets worse.
- Net errors (ERR_HTTP2_PROTOCOL_ERROR, ERR_FAILED, ERR_TIMED_OUT) on a marketing domain usually mean bot detection is blocking — emit done_failed with reason.`;

export async function nextAction(input: {
  goal: string;
  url: string;
  username: string | null;
  passwordHint: string;            // "saved password available" — never the actual value
  screenshotB64: string;
  domSnapshot: string;
  lastActionResult: string;
  step: number;
}): Promise<Action> {
  const userText = `Goal: ${input.goal}
URL: ${input.url}
Username: ${input.username ?? "(none)"}
Password: ${input.passwordHint}
Step: ${input.step}
Last action result: ${input.lastActionResult}

Aria snapshot:
${input.domSnapshot}`;

  const client = await getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: input.screenshotB64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const txt = (resp.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined)?.text ?? "";
  return parseAction(txt);
}

// Special token used by the worker to substitute the real password just before
// dispatching a `type` action whose value === PASSWORD_PLACEHOLDER. Keeps the
// plaintext out of the LLM context entirely.
export const PASSWORD_PLACEHOLDER = "{{PASSWORD}}";

function parseAction(raw: string): Action {
  // Tolerate stray fences or leading prose.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`no JSON in LLM output: ${raw.slice(0, 200)}`);
  const json = raw.slice(start, end + 1);
  const a = JSON.parse(json) as Action;
  if (!a || typeof a !== "object" || !("type" in a)) {
    throw new Error(`malformed action: ${json.slice(0, 200)}`);
  }
  return a;
}
