// Mobile uses the SAME Supabase project as the web dashboard. Same auth
// table, same edge functions, same storage buckets. The anon key + URL
// live in .env (build-time, baked into the Capacitor bundle).
//
// `persistSession: true` stores the session in localStorage. Capacitor
// webviews preserve localStorage across cold starts, so the user only
// signs in once. After that we layer biometric (Face ID / fingerprint)
// quick-unlock on top via lib/biometric.ts.

import { createClient } from "@supabase/supabase-js";

// Hard-coded production fallbacks. If a CI build ever ships without the
// VITE_* values baked in (e.g. a GitHub Actions secret wasn't set), we'd
// rather route to production than hard-throw at module load — a throw
// here crashes the JS bundle BEFORE React mounts and shows a blank
// WebView, which is impossible for a customer to diagnose. With these
// fallbacks the app still boots and any auth call surfaces a normal
// network error in the login screen.
const PROD_URL = "https://api-ems.rudrans.com";
const PROD_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc4NTUyOTU5LCJleHAiOjIwOTM5MTI5NTl9.kKjcCGveLa8gnkBcTFLBkTHZsn5II1AvQDpoKLXHFS0";

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || PROD_URL;
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || PROD_ANON;

// Bypass supabase-js's navigator.locks-based cross-tab coordination. The default
// lock deadlocks on some Android WebView builds where navigator.locks is
// present but broken (Android 7-9 in particular), causing
// signInWithPassword() to hang forever — the symptom the user reported as
// "Signing in… stuck on some Androids". A WebView never has multi-tab session
// sharing requirements, so a no-op lock is the right answer here.
const noopLock = async <R>(_name: string, _timeout: number, fn: () => Promise<R>): Promise<R> => fn();

export const supabase = createClient(URL, ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // PWA path: OAuth callback drops the token in the URL hash; supabase-js
    // auto-detects + persists. Capacitor file:// origin won't hit this code
    // path (no URL hash flow), so leaving this true is safe on both.
    detectSessionInUrl: true,
    lock: noopLock,
  },
});

export const SUPABASE_URL = URL;
