// Thin REST client for the four edge functions the worker talks to.
// No supabase-js SDK — we don't need it, and it pulls in extra deps.

const URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");

export interface ClaimedJob {
  job_id: string;
  org_id: string;
  credential_id: string;
  platform_name: string;
  login_url: string | null;
  username: string | null;
  password: string;
  totp_secret: string;
  session_cookies: string;
  otp_primary_channel: string;
  otp_fallback_channels: string[];
  otp_admin_user_ids: string[];
  billing_period_start: string;
  billing_period_end: string;
}

export interface CompletePayload {
  job_id: string;
  outcome: "success" | "failed" | "needs_human" | "needs_otp_timeout";
  error?: string;
  invoice?: {
    invoice_number?: string;
    issue_date?: string;
    period_start?: string;
    period_end?: string;
    amount?: number;
    currency?: string;
    status?: "paid" | "pending" | "overdue" | "failed" | "refunded" | "draft";
    pdf_base64?: string;
    pdf_filename?: string;
  };
  session_cookies?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${URL}/functions/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(json as { error?: string }).error ?? text}`);
  return json as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL}/functions/v1/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(json as { error?: string }).error ?? text}`);
  return json as T;
}

export async function claimJobs(workerId: string, max = 1): Promise<ClaimedJob[]> {
  const { jobs } = await post<{ jobs: ClaimedJob[] }>("invoice-job-claim", { worker_id: workerId, max });
  return jobs;
}

export async function completeJob(payload: CompletePayload): Promise<void> {
  await post("invoice-job-complete", payload);
}

export async function requestOtp(jobId: string, prompt: string): Promise<{ request_id: string; poll_url: string; expires_at: string }> {
  return post("invoice-otp-request", { job_id: jobId, prompt });
}

export async function pollOtp(requestId: string): Promise<{ status: "pending" | "fulfilled" | "expired" | "cancelled"; code: string | null }> {
  return get(`invoice-otp-status?id=${encodeURIComponent(requestId)}`);
}

// Read a row from public.integrations directly via PostgREST. Used to
// fetch the Anthropic API key on startup so super-admin can rotate it
// from /admin/integrations without redeploying the worker.
export async function getIntegration(key: string): Promise<string> {
  const r = await fetch(
    `${URL}/rest/v1/integrations?key=eq.${encodeURIComponent(key)}&select=value`,
    {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
      },
    },
  );
  if (!r.ok) throw new Error(`integrations ${r.status}: ${await r.text()}`);
  const rows = await r.json() as Array<{ value: string | null }>;
  return rows?.[0]?.value ?? "";
}
