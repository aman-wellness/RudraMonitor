// Read live-editable integration credentials from the `integrations` table
// using the service-role client. Falls back to Deno.env if a row is missing or
// blank, so existing project secrets keep working as a default.
//
// Cached for 30s in-process to avoid hammering the DB on every invocation —
// changes from the admin UI take effect within ~30s without a redeploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

let cache: Record<string, string> | null = null;
let cacheAt = 0;
const TTL_MS = 30_000;

async function loadAll(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await admin.from("integrations").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.value && String(row.value).trim() !== "") out[row.key] = String(row.value);
  }
  cache = out;
  cacheAt = now;
  return out;
}

export async function getIntegration(key: string, fallbackEnv = true): Promise<string> {
  const all = await loadAll();
  if (all[key]) return all[key];
  if (fallbackEnv) return Deno.env.get(key) ?? "";
  return "";
}

export async function getIntegrations(keys: string[]): Promise<Record<string, string>> {
  const all = await loadAll();
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = all[k] || Deno.env.get(k) || "";
  }
  return out;
}
