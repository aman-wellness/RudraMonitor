// Thin wrapper around OpenAI's HTTP API used by the marketing-automation
// edge functions. Centralises:
//   - API-key resolution (env var, single source of truth)
//   - JSON-mode request shaping (script + captions structured output)
//   - DALL-E 3 + TTS endpoints
//   - Responses API with built-in web_search tool for trend lookup
//   - Cost accounting (returns approximate USD spent per call so the
//     edge function can persist it into marketing_drafts.openai_cost_usd)
//
// Single API key in MARKETING_OPENAI_API_KEY. NOT shared with the DLP
// classifier's keys (which live in the `integrations` table) — keep
// these separate so marketing spend doesn't accidentally drain the
// DLP-budget customer key.

const OPENAI_API = "https://api.openai.com/v1";

function key(): string {
  const k = Deno.env.get("MARKETING_OPENAI_API_KEY") ?? "";
  if (!k) throw new Error("MARKETING_OPENAI_API_KEY not configured");
  return k;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

// Pricing as of 2026-05. Update when OpenAI shifts. These are LIST
// prices — actual invoiced may be lower with credits.
const PRICE = {
  gpt4o_input_per_1k:  0.0025,
  gpt4o_output_per_1k: 0.010,
  // DALL-E 3 standard 1024x1024 → $0.040 per image.
  dalle3_std_image:    0.040,
  // TTS-1 → $0.015 per 1k chars.
  tts1_per_1k_chars:   0.015,
};

export function gpt4oCost(usage?: Usage): number {
  if (!usage) return 0;
  const p = (usage.prompt_tokens ?? 0) / 1000 * PRICE.gpt4o_input_per_1k;
  const o = (usage.completion_tokens ?? 0) / 1000 * PRICE.gpt4o_output_per_1k;
  return Math.round((p + o) * 10000) / 10000;
}

export function dalleCost(images: number): number {
  return Math.round(images * PRICE.dalle3_std_image * 10000) / 10000;
}

export function ttsCost(chars: number): number {
  return Math.round(chars / 1000 * PRICE.tts1_per_1k_chars * 10000) / 10000;
}

// ---- Responses API w/ web_search built-in tool ----
//
// Used for trend research. The model decides when to call web_search
// itself; we just hand it a prompt and read the final text response.
// Falls back to chat-completions if Responses API rejects (e.g. older
// org tier without the new endpoint).
export async function searchTrends(prompt: string): Promise<{ text: string; cost: number }> {
  // Try Responses API first.
  const resp = await fetch(`${OPENAI_API}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: prompt,
      tools: [{ type: "web_search" }],
      temperature: 0.7,
    }),
  });
  if (resp.ok) {
    const j: { output_text?: string; usage?: Usage } = await resp.json();
    return { text: String(j.output_text ?? ""), cost: gpt4oCost(j.usage) };
  }
  // Fallback — plain chat completion, no web_search.
  console.warn("openai responses API rejected, falling back to chat-completions:", await resp.text());
  const cc = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });
  if (!cc.ok) throw new Error(`openai chat-completions: ${cc.status} ${await cc.text()}`);
  const j = await cc.json();
  return {
    text: String(j.choices?.[0]?.message?.content ?? ""),
    cost: gpt4oCost(j.usage),
  };
}

// ---- Plain JSON chat (script + scene prompts + captions) ----
export async function jsonChat<T = unknown>(systemPrompt: string, userPrompt: string): Promise<{ data: T; cost: number }> {
  const r = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
    }),
  });
  if (!r.ok) throw new Error(`openai json chat: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return {
    data: JSON.parse(j.choices?.[0]?.message?.content ?? "{}") as T,
    cost: gpt4oCost(j.usage),
  };
}

// ---- DALL-E 3 image generation ----
export async function generateImage(prompt: string, size: "1024x1024" | "1792x1024" = "1024x1024"): Promise<{ bytes: Uint8Array; cost: number }> {
  const r = await fetch(`${OPENAI_API}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      size,
      n: 1,
      response_format: "b64_json",
      quality: "standard",
    }),
  });
  if (!r.ok) throw new Error(`openai image: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const b64 = j.data?.[0]?.b64_json as string | undefined;
  if (!b64) throw new Error("openai image: empty response");
  // Decode base64 to bytes for upload.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, cost: dalleCost(1) };
}

// ---- TTS (text-to-speech) — `tts-1` model, mp3 output ----
export async function tts(text: string, voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "nova"): Promise<{ bytes: Uint8Array; cost: number }> {
  const r = await fetch(`${OPENAI_API}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: text,
      response_format: "mp3",
    }),
  });
  if (!r.ok) throw new Error(`openai tts: ${r.status} ${await r.text()}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { bytes: buf, cost: ttsCost(text.length) };
}
