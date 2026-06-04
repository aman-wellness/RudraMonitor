// Email + password login. Same Supabase account as the web dashboard.
// After a successful sign-in, prompts the user (one time only) to
// enable biometric quick-unlock; the password is stored in iOS Keychain
// / Android KeyStore via lib/biometric.ts.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { isAvailable as bioAvailable, saveCredentials } from "../lib/biometric";
import { Preferences } from "@capacitor/preferences";
import { startOAuth } from "../lib/oauth";

const ASKED_BIO_KEY = "biometric_prompted";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [orgHint, setOrgHint] = useState<string | null>(null);

  // Live preview: as the user types their email, we ping the public RPC
  // `org_claim_by_email` to tell them which org they'll be added to. This
  // catches typos before sign-in ("oh, I typed acme.in but my org claims
  // acme.com") and reassures them they're hitting the right tenant.
  useEffect(() => {
    if (!email.includes("@")) { setOrgHint(null); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc("org_claim_by_email", { p_email: email.trim() });
      const row = Array.isArray(data) ? data[0] : null;
      setOrgHint(row?.org_name ?? null);
    }, 400);
    return () => clearTimeout(t);
  }, [email]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Hard 20s timeout — on some Android WebViews fetch() can hang
      // indefinitely on a flaky network or a broken navigator.locks
      // implementation, leaving the user staring at "Signing in…" forever.
      // Race against a timer so they always get either a session or a
      // clear error within 20 seconds.
      const signInPromise = supabase.auth.signInWithPassword({ email: email.trim(), password });
      const timeoutPromise = new Promise<{ error: Error }>((resolve) =>
        setTimeout(() => resolve({ error: new Error("Network timeout — check your internet connection and try again.") }), 20000),
      );
      const result = await Promise.race([signInPromise, timeoutPromise]) as { error: Error | null };
      if (result.error) throw result.error;
    } catch (e) {
      setErr((e as Error).message || "Login failed. Please try again.");
      setBusy(false);
      return;
    }
    // From here on, auth succeeded. Reset the button immediately so the
    // router can flip to the signed-in routes; the biometric enrolment
    // prompt is fire-and-forget after that. Previously biometric
    // bioAvailable() / confirm() blocking on some Android devices kept
    // the button stuck on "Signing in…" forever even though the user
    // was already authenticated.
    setBusy(false);
    void (async () => {
      try {
        const asked = await Preferences.get({ key: ASKED_BIO_KEY });
        if (asked.value === "1") return;
        if (!(await bioAvailable())) return;
        await Preferences.set({ key: ASKED_BIO_KEY, value: "1" });
        if (confirm("Enable Face ID / fingerprint for faster sign-in next time?")) {
          const r = await saveCredentials(email.trim(), password);
          if (!r.ok) console.warn("biometric save failed:", r.error);
        }
      } catch (bioErr) {
        console.warn("biometric enrolment skipped:", bioErr);
      }
    })();
  };

  const oauth = async (provider: "google" | "azure") => {
    setBusy(true);
    setErr(null);
    try {
      // startOAuth picks PWA vs native flow. Native opens a Chrome
      // Custom Tab; the user signs in there and Android deep-links
      // them back to the app via com.wellnessextract.invoice://oauth-callback,
      // which App.tsx's appUrlOpen listener exchanges for a session.
      await startOAuth(provider);
      // On native, control returns here immediately — the actual sign-in
      // resolves later via the deep link. We can't reliably know when
      // the user has either completed sign-in or backed out, so guard
      // with a 90 s ceiling: if no session has arrived by then, unstick
      // the button and surface the email-password alternative. Without
      // this guard, browsers that block the custom-scheme deep link
      // (HeyTapBrowser, Samsung Internet) leave the button frozen on
      // "Signing in…" with no recovery short of force-quit.
      window.setTimeout(() => {
        setBusy((current) => {
          if (current) {
            setErr("Sign-in didn't return to the app. Try again, or use email + password below.");
            return false;
          }
          return current;
        });
      }, 90000);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top)",
      paddingBottom: "env(safe-area-inset-bottom)",
      background: "#0f1115",
    }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 24px" }}>
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{
            width: 64, height: 64, margin: "0 auto 16px",
            background: "#22d3a2", borderRadius: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 32,
          }}>📷</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Wellness Extract Invoice</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#9ba3af" }}>
            Sign in with your Wellness Extract account
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <button onClick={() => oauth("google")} disabled={busy} style={oauthBtn}>
            <GoogleLogo /> Continue with Google
          </button>
          <button onClick={() => oauth("azure")} disabled={busy} style={oauthBtn}>
            <MicrosoftLogo /> Continue with Microsoft
          </button>
        </div>

        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          margin: "4px 0 12px",
          fontSize: 11, color: "#6b7280",
        }}>
          <div style={{ flex: 1, height: 1, background: "#1f242c" }} />
          <span>or with email</span>
          <div style={{ flex: 1, height: 1, background: "#1f242c" }} />
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
          {orgHint && (
            <div style={{
              padding: "8px 12px",
              background: "rgba(34,211,162,0.08)",
              border: "1px solid rgba(34,211,162,0.25)",
              borderRadius: 8,
              fontSize: 11,
              color: "#22d3a2",
            }}>
              ✓ You'll join <strong style={{ color: "#fff" }}>{orgHint}</strong> based on your email domain
            </div>
          )}
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
          {err && (
            <div style={{
              padding: "10px 12px",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              fontSize: 12,
              color: "#fca5a5",
            }}>{err}</div>
          )}
          <button
            type="submit"
            disabled={busy || !email || !password}
            style={{
              padding: "14px 16px",
              background: "#22d3a2",
              color: "#0f1115",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              opacity: (busy || !email || !password) ? 0.5 : 1,
              cursor: (busy || !email || !password) ? "not-allowed" : "pointer",
              marginTop: 8,
            }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p style={{ marginTop: 32, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
          Same email + password as <span style={{ color: "#22d3a2" }}>ems.wellnessextract.com</span>.
          <br />Forgot password? Reset it on the web dashboard.
        </p>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px 14px",
  background: "#1a1f27",
  border: "1px solid #2a313c",
  borderRadius: 10,
  color: "#fff",
  fontSize: 15,
  outline: "none",
};

const oauthBtn: React.CSSProperties = {
  width: "100%",
  padding: "13px 14px",
  background: "#fff",
  color: "#0f1115",
  border: "1px solid #d1d5db",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
};

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.61z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
    </svg>
  );
}
function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
      <rect width="10" height="10" x="1"  y="1"  fill="#F25022"/>
      <rect width="10" height="10" x="12" y="1"  fill="#7FBA00"/>
      <rect width="10" height="10" x="1"  y="12" fill="#00A4EF"/>
      <rect width="10" height="10" x="12" y="12" fill="#FFB900"/>
    </svg>
  );
}
