// OAuth Mobile Bridge — HTTPS callback that forwards an OAuth result to
// the Capacitor mobile app via a custom URL scheme.
//
// Why this exists:
//   On phones whose default browser is NOT Chrome (OnePlus / OxygenOS
//   ships HeyTapBrowser, Samsung ships Samsung Internet), the
//   `@capacitor/browser` plugin can't open Chrome Custom Tabs and falls
//   back to the system default browser. Those browsers refuse to
//   redirect from an HTTPS page to a `com.foo://` custom-scheme URL,
//   so the user gets stuck on a blank/"page can't be loaded" screen
//   right after authorising with Microsoft / Google.
//
// What this page does:
//   Supabase Auth was told to redirect to this page after OAuth
//   completes. We arrive with `?code=...&state=...` in the query
//   string. We immediately attempt to navigate to
//   `com.wellnessextract.invoice://oauth-callback?<same query>` — which
//   triggers Android's intent resolver REGARDLESS of which browser is
//   rendering us. The AndroidManifest intent-filter then routes the
//   intent to our app, and the app's appUrlOpen listener completes
//   the PKCE code exchange.
//
//   If the auto-redirect doesn't fire (very old browser, intent
//   declined, etc.), we render a visible "Open in Wellness Extract
//   Invoice" button as a manual fallback.
//
// External setup required:
//   - Supabase Studio → Auth → URL Configuration → Redirect URLs:
//     add https://ems.wellnessextract.com/oauth-mobile-bridge
//   - mobile/src/lib/oauth.ts NATIVE_REDIRECT must point here.

import { useEffect, useMemo, useState } from "react";

const APP_SCHEME_URL_BASE = "com.wellnessextract.invoice://oauth-callback";

export default function OAuthMobileBridge() {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const target = useMemo(() => `${APP_SCHEME_URL_BASE}${search}`, [search]);
  const [autoTried, setAutoTried] = useState(false);

  useEffect(() => {
    // Defer one tick so the page renders something before we try to
    // navigate away — if the intent fails the user sees the fallback
    // button instead of a blank screen.
    const t = window.setTimeout(() => {
      setAutoTried(true);
      window.location.href = target;
    }, 150);
    return () => window.clearTimeout(t);
  }, [target]);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "32px 24px",
      background: "#0f1115",
      color: "#e5e7eb",
      textAlign: "center",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: 18,
        background: "#22d3a2", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontSize: 36, marginBottom: 24,
      }}>📷</div>

      <h1 style={{ fontSize: 20, fontWeight: 600, color: "#fff", margin: "0 0 6px" }}>
        Almost there
      </h1>
      <p style={{ fontSize: 14, color: "#9ba3af", maxWidth: 320, margin: "0 0 28px", lineHeight: 1.5 }}>
        Returning you to <strong style={{ color: "#fff" }}>Wellness Extract Invoice</strong>…
        If nothing happens in a couple of seconds, tap the button below.
      </p>

      <a
        href={target}
        style={{
          display: "inline-block",
          padding: "14px 28px",
          borderRadius: 12,
          background: "#22d3a2",
          color: "#0f1115",
          fontSize: 15,
          fontWeight: 600,
          textDecoration: "none",
          minWidth: 220,
        }}
      >
        Open in app
      </a>

      <p style={{ fontSize: 11, color: "#6b7280", marginTop: 32, maxWidth: 320, lineHeight: 1.5 }}>
        Don&apos;t have the app installed yet?{" "}
        <a
          href="/downloads/wellness-extract-invoice.apk"
          style={{ color: "#22d3a2" }}
        >
          Download the Android APK
        </a>
        .
      </p>

      {autoTried && (
        <p style={{ fontSize: 10, color: "#4b5563", marginTop: 18 }}>
          Auto-redirect attempted — if you see this for more than 5 seconds,
          your browser is blocking the app launch. Tap the button manually.
        </p>
      )}
    </div>
  );
}
