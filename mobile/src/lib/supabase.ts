// Mobile uses the SAME Supabase project as the web dashboard. Same auth
// table, same edge functions, same storage buckets. The anon key + URL
// live in .env (build-time, baked into the Capacitor bundle).
//
// `persistSession: true` stores the session in localStorage. Capacitor
// webviews preserve localStorage across cold starts, so the user only
// signs in once. After that we layer biometric (Face ID / fingerprint)
// quick-unlock on top via lib/biometric.ts.

import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — check mobile/.env");
}

export const supabase = createClient(URL, ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // PWA path: OAuth callback drops the token in the URL hash; supabase-js
    // auto-detects + persists. Capacitor file:// origin won't hit this code
    // path (no URL hash flow), so leaving this true is safe on both.
    detectSessionInUrl: true,
  },
});

export const SUPABASE_URL = URL;
