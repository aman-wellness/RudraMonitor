// OAuth Mobile Bridge — HTTPS callback that forwards an OAuth result
// to the Capacitor mobile app via a custom URL scheme.
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
// What this page does (multi-strategy launch — HeyTapBrowser blocks
// some of these, others succeed; we try all in parallel):
//   1. Immediate `window.location.assign` to the custom scheme
//   2. Hidden `<iframe src="custom-scheme://…">` (works on some browsers
//      that block top-level navigation but allow iframe src)
//   3. Auto-clicked anchor tag (a synthetic user-initiated click; some
//      browsers honor this when they reject `location.href`)
//   4. Manually tappable "Open in app" button (always-visible fallback)
//
// Whichever launches Android's intent resolver first wins — the others
// no-op silently when the app foregrounds.

import { useEffect, useMemo, useRef, useState } from "react";

const APP_SCHEME_URL_BASE = "com.rudrans.invoice://oauth-callback";

export default function OAuthMobileBridge() {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const target = useMemo(() => `${APP_SCHEME_URL_BASE}${search}`, [search]);
  const [stage, setStage] = useState<"launching" | "fallback">("launching");
  const linkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    // Strategy 1: standard JS redirect
    const t1 = window.setTimeout(() => {
      try { window.location.assign(target); } catch { /* ignored */ }
    }, 100);

    // Strategy 2: synthetic user click on a real <a> tag
    const t2 = window.setTimeout(() => {
      try { linkRef.current?.click(); } catch { /* ignored */ }
    }, 400);

    // Strategy 3: hidden iframe (some browsers block top-level
    // navigation to non-http schemes but allow iframe src)
    const t3 = window.setTimeout(() => {
      try {
        const f = document.createElement("iframe");
        f.style.display = "none";
        f.src = target;
        document.body.appendChild(f);
        window.setTimeout(() => { try { document.body.removeChild(f); } catch { /* ignored */ } }, 5000);
      } catch { /* ignored */ }
    }, 700);

    // If the app didn't take over after 1.5 s, the page is still here —
    // promote the manual button to the primary action.
    const t4 = window.setTimeout(() => setStage("fallback"), 1500);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
  }, [target]);

  const isFallback = stage === "fallback";

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
        {isFallback ? "Tap to finish sign-in" : "Almost there"}
      </h1>
      <p style={{ fontSize: 14, color: "#9ba3af", maxWidth: 320, margin: "0 0 28px", lineHeight: 1.5 }}>
        {isFallback
          ? "Your browser didn’t auto-launch the app. Tap the button below to return to Rudrans Invoice."
          : "Returning you to Rudrans Invoice…"}
      </p>

      {/* Real anchor — strategy #2 above auto-clicks this ref. Stays
          rendered so the user can also tap it manually. */}
      <a
        ref={linkRef}
        href={target}
        style={{
          display: "inline-block",
          padding: "16px 32px",
          borderRadius: 12,
          background: "#22d3a2",
          color: "#0f1115",
          fontSize: 16,
          fontWeight: 700,
          textDecoration: "none",
          minWidth: 240,
          boxShadow: isFallback ? "0 0 0 4px rgba(34,211,162,0.25)" : "none",
          animation: isFallback ? "wepulse 1.2s ease-in-out infinite" : "none",
        }}
      >
        Open in app →
      </a>

      <style>{`
        @keyframes wepulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
      `}</style>

      <p style={{ fontSize: 11, color: "#6b7280", marginTop: 32, maxWidth: 320, lineHeight: 1.5 }}>
        Don&apos;t have the app installed yet?{" "}
        <a
          href="/downloads/rudrans-invoice.apk"
          style={{ color: "#22d3a2" }}
        >
          Download the Android APK
        </a>
        .
      </p>
    </div>
  );
}
