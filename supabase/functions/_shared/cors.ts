// Origins permitted to call edge functions with credentials.
// Any unlisted Origin gets Access-Control-Allow-Origin omitted, which causes
// the browser to block the cross-origin response. Webhooks (Razorpay, Microsoft
// Graph) call the functions server-to-server and do not send an Origin header,
// so they are unaffected.
const ALLOWED_ORIGINS = new Set<string>([
  "https://ems.wellnessextract.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:1420",
  "tauri://localhost",
  "https://tauri.localhost",
]);

const STATIC_HEADERS = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
};

export function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (ALLOWED_ORIGINS.has(origin)) {
    return { "Access-Control-Allow-Origin": origin, ...STATIC_HEADERS };
  }
  // Unknown / missing Origin → no ACAO. Webhooks still work (no Origin sent).
  return { ...STATIC_HEADERS };
}

// Backwards-compatible export. Pins ACAO to the production frontend so
// existing call-sites that spread `corsHeaders` into their responses don't
// regress browser callers from ems.wellnessextract.com when we tighten CORS away
// from "*". This is the ONLY browser-served frontend; any other origin
// (dashboard, www, localhost dev) must migrate the call-site to
// `corsFor(req)` so its Origin is reflected back dynamically.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ems.wellnessextract.com",
  ...STATIC_HEADERS,
};
