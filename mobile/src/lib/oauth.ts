// Capacitor-native OAuth bridge for Google + Microsoft.
//
// The web flow (signInWithOAuth in the same WebView) doesn't work on
// Android/iOS native: the OAuth provider redirects back to
// `https://localhost/m/` (Capacitor's WebView origin) which the device
// can't route back into the app. So the native path uses a Chrome
// Custom Tab (Capacitor Browser) for the sign-in, and a custom URL
// scheme (com.wellnessextract.invoice://oauth-callback) to bring the user back
// into the app with the auth code.
//
// Flow:
//   1. Login screen calls startOAuth("google" | "azure")
//   2. We ask Supabase for the OAuth URL with skipBrowserRedirect = true
//   3. Browser.open() launches the URL in a Chrome Custom Tab
//   4. User signs in; provider redirects to com.wellnessextract.invoice://oauth-callback?code=...
//   5. Android resolves that intent to our app (intent-filter in
//      AndroidManifest.xml)
//   6. App.tsx's appUrlOpen listener calls handleDeepLink() below,
//      which extracts the `code` param and calls
//      supabase.auth.exchangeCodeForSession() — that persists the
//      session and the onAuthStateChange subscriber updates the UI.
//
// External setup required (one-time, per Supabase project):
//   - Supabase Studio → Auth → URL Configuration → Redirect URLs:
//     add `com.wellnessextract.invoice://oauth-callback`
//   - Google Cloud Console → OAuth client → Authorized redirect URIs:
//     add `https://api-ems.wellnessextract.com/auth/v1/callback` (Supabase's
//     intermediate) — the custom scheme isn't accepted by Google
//     directly; Supabase brokers it.
//   - Microsoft Entra → App registration → Redirect URIs:
//     add the same Supabase callback URL.

import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { supabase } from "./supabase";

// cordova-plugin-inappbrowser exposes `window.cordova.InAppBrowser.open`
// which, with the `_system` target, launches the URL via Android's
// Intent.ACTION_VIEW — i.e. the default browser as a SEPARATE process.
// This is the ONE path that lets Android's App Link intent-filter
// intercept the OAuth bridge URL: Capacitor's Browser plugin uses
// Chrome Custom Tabs, and Custom Tabs opened from app A do NOT break
// out to app A's own App Links (verified via adb logs — HeyTapBrowser
// loaded the bridge URL itself even though the App Link was verified).
declare global {
  interface Window {
    cordova?: {
      InAppBrowser?: {
        open: (url: string, target: string, options?: string) => unknown;
      };
    };
  }
}

// Native redirect target. We could redirect directly to the custom URL
// scheme (com.wellnessextract.invoice://oauth-callback) but on phones
// whose default browser is not Chrome — OxygenOS / HeyTapBrowser,
// Samsung Internet, MIUI Browser, etc. — that browser refuses to
// follow a 302 to a custom scheme and the user ends up stranded on a
// "page can't be loaded" screen.
//
// Instead we redirect to an HTTPS page hosted on our own domain. That
// page (src/pages/oauth-mobile-bridge/page.tsx) immediately attempts
// `window.location = "com.wellnessextract.invoice://oauth-callback?<query>"`
// which DOES trigger Android's intent resolver from any browser, and
// also renders a tap-to-open fallback button if the auto-redirect is
// blocked. Browser-agnostic and works on every Android.
//
// IMPORTANT external setup:
//   - Supabase Studio → Auth → URL Configuration → Redirect URLs must
//     include `https://ems.wellnessextract.com/oauth-mobile-bridge`
//     (alongside the existing custom-scheme entry).
// Static HTML bridge (NOT the SPA route). The previous /oauth-mobile-bridge
// React route imported the dashboard's supabase-js client which has
// `detectSessionInUrl: true` — meaning it auto-exchanged the one-shot
// PKCE `code` the moment the page loaded, leaving the mobile app with
// nothing to exchange. The plain HTML file at /oauth-bridge.html
// imports no JS framework or auth library; it just forwards the query
// string into the app's custom scheme so the app can finish PKCE on
// its own.
const NATIVE_REDIRECT = "https://ems.wellnessextract.com/oauth-bridge.html";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export async function startOAuth(provider: "google" | "azure"): Promise<void> {
  if (!isNative()) {
    // PWA path — let supabase-js handle the redirect in-place.
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/m/`,
        ...(provider === "azure"
          ? { scopes: "email openid profile", queryParams: { prompt: "select_account" } }
          : {}),
      },
    });
    if (error) throw error;
    return;
  }

  // Native: get the URL but don't redirect — open it in Chrome Custom Tab.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: NATIVE_REDIRECT,
      skipBrowserRedirect: true,
      ...(provider === "azure"
        ? { scopes: "email openid profile", queryParams: { prompt: "select_account" } }
        : {}),
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("Supabase returned no OAuth URL");

  // Extract the OAuth `state` param from the URL — this is the key the
  // bridge will use to deposit the auth `code` server-side. We need it
  // here so we can poll the retrieve endpoint after the browser closes.
  const stateMatch = /[?&]state=([^&]+)/.exec(data.url);
  const oauthState = stateMatch ? decodeURIComponent(stateMatch[1]) : "";

  // Kick off polling BEFORE opening the browser so even fast OAuth
  // round-trips don't race past the first poll. (Belt-and-braces; with
  // App Links the polling shouldn't be needed because Android routes
  // the bridge URL straight to the app, but on iOS / older Androids
  // the deposit/retrieve handoff is still the actual mechanism.)
  if (oauthState) pollHandoff(oauthState);

  // Prefer InAppBrowser's `_system` target — this fires Android's
  // Intent.ACTION_VIEW which honors App Link verification, so the
  // bridge URL on return gets intercepted directly into THIS app
  // (verified via `adb shell am start`: that exact intent resolves
  // to com.wellnessextract.invoice/.MainActivity). Capacitor's
  // Browser.open uses Custom Tabs which silently swallow the App
  // Link interception when the originating app is the target.
  const win = window as Window;
  if (win.cordova?.InAppBrowser?.open) {
    win.cordova.InAppBrowser.open(data.url, "_system");
  } else {
    // Fallback (iOS, or if the plugin isn't bundled): Capacitor Browser.
    await Browser.open({ url: data.url, presentationStyle: "popover" });
  }
}

/// Poll the server-side handoff store for a deposited PKCE `code`.
/// Resolves silently once a code is exchanged into a session; gives up
/// after ~2 minutes. Browser-cooperation independent — works on every
/// OEM browser (HeyTapBrowser, Samsung Internet, MIUI Browser, ...)
/// because the only thing the browser has to do is one HTTPS POST.
function pollHandoff(state: string): void {
  const RETRIEVE_URL =
    "https://api-ems.wellnessextract.com/functions/v1/oauth-mobile-retrieve";
  const startedAt = Date.now();
  const stopAfterMs = 120_000;
  let exchanged = false;

  const tick = async (): Promise<void> => {
    if (exchanged) return;
    if (Date.now() - startedAt > stopAfterMs) {
      console.warn("oauth.pollHandoff: timeout — no code deposited in 2 min");
      return;
    }
    try {
      const r = await fetch(`${RETRIEVE_URL}?state=${encodeURIComponent(state)}`);
      if (r.ok) {
        const body = (await r.json()) as { ready?: boolean; code?: string };
        if (body.ready && body.code) {
          exchanged = true;
          const { error } = await supabase.auth.exchangeCodeForSession(body.code);
          if (error) {
            console.error("oauth.pollHandoff: exchangeCodeForSession:", error.message);
            return;
          }
          // Best-effort close any leftover custom tab.
          try { await Browser.close(); } catch { /* ignore */ }
          return;
        }
      }
      // Either 404 (not ready yet) or transient error — try again.
    } catch (e) {
      console.warn("oauth.pollHandoff fetch:", (e as Error).message);
    }
    window.setTimeout(tick, 1000);
  };
  void tick();
}

/// Called by App.tsx when Android delivers a `com.wellnessextract.invoice://` deep
/// link. Extracts the PKCE `code` from the URL and exchanges it with
/// Supabase for a session. Returns true if a session was established.
export async function handleDeepLink(url: string): Promise<boolean> {
  // URL shapes we accept:
  //   1. com.wellnessextract.invoice://oauth-callback?code=…&state=…
  //      (legacy custom-scheme deep link)
  //   2. https://ems.wellnessextract.com/oauth-bridge.html?code=…&state=…
  //      (Android App Link — Android intercepts the bridge URL and routes
  //      it here directly, bypassing whatever browser would otherwise
  //      strip the query params. Requires assetlinks.json + the
  //      autoVerify intent-filter in AndroidManifest.)
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    if (!code) {
      // Could be a non-OAuth deep link (e.g. future invoice-share link);
      // not an error.
      return false;
    }
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    // Close the Chrome Custom Tab so the user lands back in the app
    // immediately, not on a "Signed in, you can close this tab" page.
    try { await Browser.close(); } catch { /* ignore */ }
    return true;
  } catch (e) {
    console.error("oauth.handleDeepLink:", e);
    throw e;
  }
}
