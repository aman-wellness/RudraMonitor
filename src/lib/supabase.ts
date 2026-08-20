import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Surface a clear error in dev rather than failing silently downstream.
  console.error(
    '[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in values.'
  );
}

// Bypass supabase-js's navigator.locks-based cross-tab coordination. The default
// lock can deadlock if a tab is closed mid-auth, leaving getSession() hanging
// forever. We don't have multi-tab session sharing requirements, so a no-op lock
// is safe.
const noopLock = async <R>(_name: string, _timeout: number, fn: () => Promise<R>): Promise<R> => fn();

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    lock: noopLock,
  },
});

// Re-export the base URL so other modules can build edge-function URLs
// without re-reading the env var.
export const SUPABASE_URL = url ?? '';

export type Organization = {
  id: string;
  owner_user_id: string;
  name: string;
  contact_person: string | null;
  gst_number: string | null;
  pan_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  created_at: string;
  trial_ends_at: string;
  subscription_status: 'trial' | 'active' | 'expired';
  subscription_type: 'monthly' | 'yearly' | null;
  license_count: number;
  license_key: string;
  partner_id: string | null;
};

export type AppRole = 'super_admin' | 'partner' | 'customer';

export type AppUser = {
  user_id: string;
  app_role: AppRole;
  partner_id: string | null;
  created_at: string;
};

export type PartnerStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export type Partner = {
  id: string;
  name: string;
  contact_person: string | null;
  contact_email: string;
  phone: string | null;
  gst_number: string | null;
  pan_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  status: PartnerStatus;
  commission_pct: number;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  payment_mode: string | null;
  gst_certificate_url: string | null;
  authorization_letter_url: string | null;
  cancelled_cheque_url: string | null;
  notes: string | null;
  created_at: string;
};

export type PartnerMember = {
  id: string;
  partner_id: string;
  user_id: string;
  role: 'admin' | 'staff';
  full_name: string | null;
  email: string | null;
  created_at: string;
};

export type Plan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  seat_count: number;
  price_inr: number;          // Customer-facing list price (used for invoicing/GST)
  price_usd: number | null;   // Website-facing list price (marketing site)
  partner_price_inr: number;  // Wholesale price Wellness Extract charges partners
  billing_cycle: 'monthly' | 'yearly';
  is_active: boolean;
  created_at: string;
};

export type LicenseStatus = 'active' | 'suspended' | 'expired' | 'revoked';

export type License = {
  id: string;
  license_key: string;
  organization_id: string;
  partner_id: string | null;
  plan_id: string;
  seat_count: number;
  status: LicenseStatus;
  issued_by: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  notes: string | null;
  created_at: string;
};

export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'cancelled';

export type Invoice = {
  id: string;
  invoice_number: string;
  organization_id: string;
  partner_id: string | null;
  license_id: string | null;
  plan_id: string | null;
  amount_inr: number;
  gst_pct: number;
  gst_amount_inr: number;
  total_inr: number;
  partner_commission_inr: number;
  status: InvoiceStatus;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  issued_at: string;
  due_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
};

export type AuditLogEntry = {
  id: number;
  actor_user: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type DlpEventType = 'usb_transfer' | 'email_attachment' | 'clipboard_exfil';
export type DlpSeverity = 'low' | 'medium' | 'high' | 'critical';

export type DlpEvent = {
  id: string;
  org_id: string;
  agent_id: string;
  event_type: DlpEventType;
  direction: 'to_external' | 'from_external' | 'unknown' | null;
  device_name: string | null;
  device_serial: string | null;
  device_type: string | null;
  mail_provider: string | null;
  mail_url: string | null;
  sender_email: string | null;
  recipient_email: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  file_mime: string | null;
  file_hash_sha256: string | null;
  active_window: string | null;
  screenshot_url: string | null;
  ai_authorized: boolean | null;
  ai_severity: DlpSeverity | null;
  ai_reason: string | null;
  ai_model: string | null;
  ai_processed_at: string | null;
  alert_sent_at: string | null;
  alert_email: string | null;
  occurred_at: string;
  created_at: string;
};

export type DlpAlertRecipient = {
  id: string;
  org_id: string | null;
  email: string;
  full_name: string | null;
  is_active: boolean;
  severities: DlpSeverity[];
  created_at: string;
};

export type DlpSettings = {
  org_id: string;
  usb_enabled: boolean;
  email_enabled: boolean;
  clipboard_enabled: boolean;
  authorized_domains: string[];
  blocked_keywords: string[];
  ai_policy_prompt: string | null;
  updated_at: string;
};

export type Agent = {
  id: string;
  org_id: string;
  agent_name: string;
  machine_name: string | null;
  department: string | null;
  os_type: string | null;
  status: 'online' | 'offline' | 'idle' | null;
  last_active: string | null;
  ip_address: string | null;
  enroll_token: string;
  created_at: string;
  // Populated when reading from the `agents_with_seat` view (migration
  // 0078). seat_locked=true means the agent is beyond the org's licensed
  // seat_count and the server is refusing its ingest calls.
  seat_rank?: number;
  seat_locked?: boolean;
  // Per-agent capture cadence. Read straight off the row the UI already
  // fetches, so screens can state the REAL interval instead of repeating a
  // "captures every 5 minutes" claim in prose.
  idle_threshold_secs?: number | null;
  screenshot_interval_secs?: number | null;
  video_interval_secs?: number | null;
};
