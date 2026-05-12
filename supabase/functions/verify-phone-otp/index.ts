// POST /functions/v1/verify-phone-otp
// PUBLIC. Body: { email, otp }
//
// Checks the latest unused OTP for this email against the supplied code.
// On match: marks code as used + writes contact_verifications so the signup
// flow knows the email is verified for 30 minutes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_ATTEMPTS = 5;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { email?: string; otp?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  const otp = (body.otp ?? "").trim();
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
  if (!/^\d{6}$/.test(otp)) return json({ error: "6-digit OTP required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Latest unused, unexpired code for this email.
  const { data: row } = await admin
    .from("otp_codes")
    .select("id, code_hash, attempts, expires_at")
    .ilike("target", email)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return json({ error: "No active OTP — request a new one" }, 400);

  if (row.attempts >= MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Request a new OTP." }, 400);
  }

  const hash = await sha256Hex(otp);
  if (hash !== row.code_hash) {
    await admin.from("otp_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return json({ error: "Incorrect code" }, 400);
  }

  // Success — mark this code used and record verification.
  await admin.from("otp_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id);
  await admin
    .from("contact_verifications")
    .upsert({ target: email, verified_at: new Date().toISOString() }, { onConflict: "target" });

  return json({ ok: true, verified_email: email });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
