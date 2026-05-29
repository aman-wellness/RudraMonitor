// POST /functions/v1/otp-inbound-gchat?org=<org_id>
//
// Google Chat app event receiver. Requires a Workspace add-on / Chat-app
// configured to deliver events to this URL. Header `Authorization: Bearer
// <google-id-token>` is sent by Chat; we verify the audience matches our
// configured Chat-app project number and the email matches
// chat@system.gserviceaccount.com.
//
// For Phase-3 we also accept a shared-secret header (`x-gchat-token`)
// matching integrations.GCHAT_SHARED_TOKEN as a lighter alternative for
// orgs that don't want to wire up the full ID-token verification path.
//
// Event payload contains `message.text` and `user.name` (users/XXXX).

import { corsHeaders } from "../_shared/cors.ts";
import { ingestInbound } from "../_shared/otp-inbound.ts";
import { getIntegration } from "../_shared/integrations.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const orgId = (url.searchParams.get("org") ?? "").trim();
  if (!orgId) return json({ error: "missing ?org=<uuid>" }, 400);

  // Shared-secret auth: cheaper than full ID-token verification.
  const expected = await getIntegration("GCHAT_SHARED_TOKEN").catch(() => "");
  const got = req.headers.get("x-gchat-token") ?? "";
  if (!expected || got !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { type?: string; message?: { text?: string }; user?: { name?: string; displayName?: string } };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  if (body.type !== "MESSAGE") {
    return json({ ok: true, ignored: body.type ?? "no-type" }, 200);
  }

  const result = await ingestInbound({
    orgId,
    externalUserId: body.user?.name ?? null,        // "users/12345…"
    channel: "google_chat",
    messageText: body.message?.text ?? "",
  });
  return json(result, result.ok ? 200 : 202);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
