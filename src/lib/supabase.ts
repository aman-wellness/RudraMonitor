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
  gst_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  created_at: string;
  trial_ends_at: string;
  subscription_status: 'trial' | 'active' | 'expired';
  subscription_type: 'monthly' | 'yearly' | null;
  license_count: number;
  license_key: string;
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
