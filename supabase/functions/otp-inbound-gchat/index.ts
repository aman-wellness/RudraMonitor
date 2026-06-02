// POST /functions/v1/otp-inbound-gchat
//
// Google Chat App event receiver. The Rudrans Chat App (published once in
// our Google Cloud project, Chat API → Configuration → HTTP endpoint URL =
// this URL) POSTs every MESSAGE event in every space it's been added to.
// We extract the OTP code from the message text and fulfill the matching
// pending request.
//
// Auth: Google Chat signs every request with a JWT in the Authorization
//   header. Issuer is `chat@system.gserviceaccount.com`, audience is our
//   Chat App's project number (GCHAT_APP_AUDIENCE env). Both verified
//   before we trust the payload — otherwise anyone could POST fake OTPs.
//
// Org matching:
//   Each event's `space.name` (e.g. "spaces/AAAAxxxxx") is looked up in
//   org_otp_settings.google_chat_space_name. The customer populates that
//   column from the OTP Channels page when they paste their space ID.
//
// Reply: We return a JSON {text: "…"} body. Google Chat renders that
//   inline as the Chat App's response, so the admin in the space sees
//   confirmation ("✅ OTP applied") without leaving Chat.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { ingestInbound } from "../_shared/otp-inbound.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The Chat App's GCP project number (NOT project id). Required for JWT
// audience verification. Set the env var on supabase-edge-functions when
// the Chat App is registered. Leaving it blank skips audience check
// (acceptable for staging; never for production).
const CHAT_APP_AUDIENCE = (Deno.env.get("GCHAT_APP_AUDIENCE") || "").trim();
const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: true, note: "method ignored" }, 200);

  const auth = req.headers.get("authorization") ?? "";
  const jwt  = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  let claims: JwtClaims;
  try {
    claims = await verifyGoogleChatJwt(jwt);
  } catch (e) {
    return json({ error: `jwt verify: ${(e as Error).message}` }, 401);
  }
  if (claims.iss !== GOOGLE_CHAT_ISSUER) {
    return json({ error: `unexpected issuer: ${claims.iss}` }, 401);
  }
  if (CHAT_APP_AUDIENCE && String(claims.aud ?? "") !== CHAT_APP_AUDIENCE) {
    return json({ error: "audience mismatch" }, 401);
  }

  let body: ChatEvent;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // Lifecycle events — respond 200 with no-op. ADDED_TO_SPACE means the
  // customer just added the Chat App to their space; we don't act on it
  // here (they paste the space id into Rudrans manually). REMOVED leaves
  // any settings in place — reinstall reuses the same space id.
  if (body.type !== "MESSAGE") {
    return json({ ok: true, ignored: body.type }, 200);
  }

  const spaceName = body.space?.name ?? "";
  const text      = body.message?.text ?? body.message?.argumentText ?? "";
  const senderId  = body.user?.name ?? null;
  if (!spaceName) return json({ error: "missing space.name" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: row } = await admin
    .from("org_otp_settings")
    .select("org_id")
    .eq("google_chat_space_name", spaceName)
    .maybeSingle();
  if (!row?.org_id) {
    // The space exists in Google Chat but no org has claimed it yet.
    // Reply with a discoverability hint so whoever's in the space knows
    // what to do. Returning 200 prevents Google from retrying.
    return json({
      text: "Rudrans is here but no org has linked this space yet. Paste this space's ID into Rudrans → Employees → OTP Channels → Google Chat → Space name:\n\n`" + spaceName + "`",
    }, 200);
  }

  const result = await ingestInbound({
    orgId: row.org_id as string,
    externalUserId: senderId,
    channel: "google_chat",
    messageText: text,
  });

  if (result.ok) {
    return json({ text: "✅ OTP received and applied." }, 200);
  }
  if (result.note === "no 4-8 digit code found in message") {
    // Don't spam the space on every chat — only flag if the message LOOKED
    // like an OTP attempt (has at least one digit).
    if (/\d/.test(text)) return json({ text: "⚠️ Couldn't read an OTP code from that message." }, 200);
    return json({ ok: true, ignored: "non-otp message" }, 200);
  }
  return json({ text: `⚠️ ${result.note ?? "OTP could not be applied."}` }, 200);
});

// ── Google Chat JWT verification ──────────────────────────────────────────

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
}

interface ChatEvent {
  type: "MESSAGE" | "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE" | "CARD_CLICKED";
  space?: { name?: string };
  user?: { name?: string; displayName?: string };
  message?: { text?: string; argumentText?: string };
}

// Cache Google's published certs ~12h — Google rotates them roughly daily.
// We avoid hitting Google on every event to keep the hot path fast.
let keyCache: { certs: Record<string, string>; expiresAt: number } | null = null;

async function loadGoogleCerts(): Promise<Record<string, string>> {
  if (keyCache && Date.now() < keyCache.expiresAt) return keyCache.certs;
  const r = await fetch(`https://www.googleapis.com/robot/v1/metadata/x509/${GOOGLE_CHAT_ISSUER}`);
  if (!r.ok) throw new Error(`fetch chat certs: ${r.status}`);
  const certs = await r.json() as Record<string, string>;
  keyCache = { certs, expiresAt: Date.now() + 12 * 3600 * 1000 };
  return certs;
}

async function verifyGoogleChatJwt(token: string): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(decodeBase64Url(headerB64)) as { kid?: string; alg?: string };
  const claims = JSON.parse(decodeBase64Url(payloadB64)) as JwtClaims;

  if (header.alg !== "RS256") throw new Error(`unsupported alg ${header.alg}`);
  if (!header.kid) throw new Error("missing kid");
  if (claims.exp && claims.exp * 1000 < Date.now() - 60_000) throw new Error("token expired");
  if (claims.iat && claims.iat * 1000 > Date.now() + 60_000) throw new Error("token not yet valid");

  const certs = await loadGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error(`unknown kid ${header.kid}`);

  const cryptoKey = await importPublicKey(pem);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig  = base64UrlToBytes(sigB64);
  const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, sig, data);
  if (!ok) throw new Error("bad signature");
  return claims;
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  // Google publishes x509 certs (PEM). WebCrypto wants SPKI, so we strip
  // the PEM envelope, parse the x509, and extract the SubjectPublicKeyInfo.
  const der = pemToDer(pem);
  const spki = extractSpki(der);
  return await crypto.subtle.importKey(
    "spki", spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"],
  );
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Locate SubjectPublicKeyInfo inside an X.509 cert by anchoring on the
// rsaEncryption OID (1.2.840.113549.1.1.1) and walking back to the
// enclosing SEQUENCE — full ASN.1 parser is overkill for this one shape.
function extractSpki(der: Uint8Array): Uint8Array {
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  for (let i = 0; i < der.length - rsaOid.length; i++) {
    let match = true;
    for (let j = 0; j < rsaOid.length; j++) {
      if (der[i + j] !== rsaOid[j]) { match = false; break; }
    }
    if (!match) continue;
    for (let back = i - 1; back > 0; back--) {
      if (der[back] !== 0x30) continue;
      const { totalLen, headerLen } = readLength(der, back + 1);
      const end = back + 1 + headerLen + totalLen;
      if (end > der.length) continue;
      if (i < end) return der.slice(back, end);
    }
  }
  throw new Error("could not locate SPKI in certificate");
}

function readLength(buf: Uint8Array, off: number): { totalLen: number; headerLen: number } {
  const first = buf[off];
  if (first < 0x80) return { totalLen: first, headerLen: 1 };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 1 + i];
  return { totalLen: len, headerLen: 1 + n };
}

function decodeBase64Url(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s));
}
function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
