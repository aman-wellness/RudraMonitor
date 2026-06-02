// POST /functions/v1/start-trial-signup
// PUBLIC. Body: { full_name, email, org_name, phone?, country? }
//
// Free, no-payment self-signup flow:
//   1. Verify the email was OTP-confirmed via contact_verifications (last 30 min).
//   2. Look up or create the auth.users row (inviteUserByEmail handles both —
//      sends our welcome invite via Microsoft Graph hook).
//   3. Create the org + 14-day trial license + owner membership.
//
// No Razorpay subscription is created here. When the trial nears expiry, the
// super-admin (or a future Razorpay-driven billing flow) can convert the
// account to paid using the existing extend_license_renewal RPC.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";

type Body = {
  full_name?: string;
  email?: string;
  org_name?: string;
  phone?: string;
  country?: string;
  // Which plan the customer wants to trial. Default 'starter-m' (basic
  // monitoring). 'em-m' = employee-management-only trial. Anything else
  // is rejected — full-feature trials require a super-admin approval via
  // trial_extension_requests (see migration 0075).
  trial_plan?: string;
};

const ALLOWED_TRIAL_PLANS = new Set(["starter-m", "em-m"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const fullName = (body.full_name ?? "").trim();
  const email    = (body.email ?? "").trim().toLowerCase();
  const orgName  = (body.org_name ?? "").trim();
  const phone    = body.phone?.trim() || null;
  const country  = (body.country ?? "India").trim();
  const trialPlanCode = (body.trial_plan ?? "starter-m").trim();
  if (!ALLOWED_TRIAL_PLANS.has(trialPlanCode)) {
    return json({ error: `Invalid trial_plan. Allowed: ${[...ALLOWED_TRIAL_PLANS].join(", ")}` }, 400);
  }

  if (!fullName)                       return json({ error: "full_name required" }, 400);
  if (!email || !email.includes("@"))  return json({ error: "valid email required" }, 400);
  if (!orgName)                        return json({ error: "org_name required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Email must have been OTP-verified in the last 30 minutes.
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: cv } = await admin
    .from("contact_verifications")
    .select("target")
    .ilike("target", email)
    .gte("verified_at", since)
    .maybeSingle();
  if (!cv) return json({ error: "Email not verified — request and enter the OTP first" }, 400);

  // Block if a user with this email already owns an org. Existing users without
  // an org are fine — they'll get linked to the new one.
  const { data: foundUserId } = await admin
    .rpc("find_auth_user_id_by_email", { p_email: email });
  let user: { id: string } | null = foundUserId ? { id: foundUserId as string } : null;
  if (user) {
    const { data: ownsOrg } = await admin
      .from("organizations").select("id").eq("owner_user_id", user.id).maybeSingle();
    if (ownsOrg) return json({ error: "An account with this email already exists. Sign in instead." }, 409);
  } else {
    // inviteUserByEmail creates the auth user AND sends a welcome+invite mail
    // via the send-auth-email hook so the customer can set a password.
    const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, invite_role: "customer_owner" },
      redirectTo: `${APP_URL}/post-login`,
    });
    if (invErr || !invited?.user) {
      return json({ error: `inviteUserByEmail: ${invErr?.message ?? "no user returned"}` }, 500);
    }
    user = invited.user;
  }

  // Pick the plan by trial_plan_code. Defaults to starter-m. The trial is
  // plan-scoped: org_effective_features() reads trial_plan_code and only
  // unlocks the features attached to that plan row. Full-feature trial
  // requires the customer to file a trial_extension_request that a super
  // admin approves (see migration 0075).
  const { data: plan } = await admin
    .from("plans").select("id, code, seat_count, billing_cycle")
    .eq("code", trialPlanCode)
    .eq("is_active", true)
    .maybeSingle();
  if (!plan) return json({ error: `Plan '${trialPlanCode}' is not configured. Contact support.` }, 500);

  const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({
      owner_user_id: user.id,
      name: orgName,
      phone, country,
      subscription_status: "trial",
      subscription_type: plan.billing_cycle,
      trial_ends_at: trialEnds,
      trial_plan_code: plan.code,
      trial_full_access: false,
      license_count: plan.seat_count,
    })
    .select("id")
    .single();
  if (orgErr) return json({ error: `org create: ${orgErr.message}` }, 500);

  // Owner membership.
  await admin
    .from("org_members")
    .upsert({ org_id: org.id, user_id: user.id, role: "owner", full_name: fullName },
            { onConflict: "org_id,user_id" });

  // Trial license — expires same time as the trial.
  const { error: licErr } = await admin
    .from("licenses")
    .insert({
      organization_id: org.id,
      plan_id: plan.id,
      seat_count: plan.seat_count,
      status: "active",
      issued_by: user.id,
      expires_at: trialEnds,
      notes: "Self-signup trial (free, no payment)",
    });
  if (licErr) return json({ error: `license create: ${licErr.message}` }, 500);

  // Best-effort: mark the verification as consumed so the same OTP window
  // can't be replayed for a second signup.
  await admin.from("contact_verifications").delete().ilike("target", email);

  await admin.from("audit_log").insert({
    actor_user: user.id, actor_role: "customer",
    action: "customer.self_signup", target_type: "organization", target_id: org.id,
    metadata: { plan_id: plan.id, plan_code: plan.code, trial_ends_at: trialEnds },
  });

  return json({ ok: true, organization_id: org.id, trial_ends_at: trialEnds });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
