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
  partner_price_inr: number;  // Wholesale price TrackForce charges partners
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
};
