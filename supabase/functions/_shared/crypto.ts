// Symmetric encryption for sensitive values stored in Postgres as base64-encoded
// pgp_sym_encrypt ciphertext (`org_integrations.refresh_token_enc`, `credentials.password_enc`).
//
// Two distinct keys, fetched from the live `integrations` table:
//   DIRECTORY_TOKEN_ENC_KEY  – for org_integrations tokens
//   CRED_VAULT_ENC_KEY       – for credentials vault passwords
// Each must be set in Admin → Integrations before the corresponding feature can be used.
//
// The encryption work happens inside Postgres via two SECURITY DEFINER RPCs
// (see migration 0027). Edge functions pass the passphrase per-call; it never
// gets logged as a query parameter because the function body re-binds it.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { getIntegration } from "./integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type KeyName = "DIRECTORY_TOKEN_ENC_KEY" | "CRED_VAULT_ENC_KEY";

async function getKey(name: KeyName): Promise<string> {
  const k = await getIntegration(name);
  if (!k || k.length < 16) {
    throw new Error(`${name} not configured (Admin → Integrations); minimum 16 chars`);
  }
  return k;
}

/** Encrypt → base64 ciphertext suitable for direct insertion into a text column. */
export async function encrypt(plaintext: string, key: KeyName): Promise<string> {
  const passphrase = await getKey(key);
  const { data, error } = await adminClient().rpc("pgp_sym_encrypt_text_to_bytea", {
    p_plain: plaintext,
    p_key: passphrase,
  });
  if (error) throw new Error(`encrypt: ${error.message}`);
  return data as string;
}

/** Decrypt a base64 ciphertext back to plaintext. */
export async function decrypt(cipherB64: string, key: KeyName): Promise<string> {
  if (!cipherB64) return "";
  const passphrase = await getKey(key);
  const { data, error } = await adminClient().rpc("pgp_sym_decrypt_bytea_to_text", {
    p_cipher_b64: cipherB64,
    p_key: passphrase,
  });
  if (error) throw new Error(`decrypt: ${error.message}`);
  return (data as string) ?? "";
}

/** Random opaque hex token for magic-links, single-use approve/reject URLs, etc. */
export function randomToken(byteLen = 32): string {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return hex;
}
