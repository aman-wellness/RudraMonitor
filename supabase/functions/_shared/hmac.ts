// Minimal HMAC-SHA-256 + sha-256 helpers for magic-link tokens.
// Lives in _shared so otp-request, otp-submit, and any future webhook
// handlers can verify tokens the same way.

import { getIntegration } from "./integrations.ts";

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(buf));
}

export async function hmacSign(payload: string, secret?: string): Promise<string> {
  const key = secret ?? await getIntegration("OTP_RELAY_HMAC_SECRET");
  if (!key) throw new Error("OTP_RELAY_HMAC_SECRET not configured");
  const cryptoKey = await crypto.subtle.importKey(
    "raw", encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
  return toHex(new Uint8Array(sig));
}

export async function hmacVerify(payload: string, sigHex: string, secret?: string): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  if (expected.length !== sigHex.length) return false;
  // constant-time compare
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return mismatch === 0;
}

export function randomTokenBase64Url(byteLen = 32): string {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(b: Uint8Array): string {
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return h;
}
