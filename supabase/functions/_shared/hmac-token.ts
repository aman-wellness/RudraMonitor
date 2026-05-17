// Compact signed-token helper: payload.b64u + "." + hmac.b64u
// Used for stateless magic-link tokens (e.g. credential-request form session).
// Key fetched from the live `integrations` table at call time.

import { getIntegration } from "./integrations.ts";

export async function signToken(payload: Record<string, unknown>, keyName: string): Promise<string> {
  const key = await loadKey(keyName);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, key);
  return `${body}.${sig}`;
}

export async function verifyToken<T = Record<string, unknown>>(token: string, keyName: string): Promise<T | null> {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await loadKey(keyName);
  const expect = await hmac(body, key);
  if (!constTimeEq(sig, expect)) return null;
  try {
    const json = new TextDecoder().decode(b64uDecode(body));
    const payload = JSON.parse(json) as T & { exp?: number };
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload as T;
  } catch {
    return null;
  }
}

async function loadKey(keyName: string): Promise<CryptoKey> {
  const raw = await getIntegration(keyName);
  if (!raw || raw.length < 16) throw new Error(`${keyName} not configured (>= 16 chars)`);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(body: string, key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return b64u(new Uint8Array(sig));
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
