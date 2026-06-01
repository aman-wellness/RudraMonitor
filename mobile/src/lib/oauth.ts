// Capacitor-native OAuth bridge for Google + Microsoft.
//
// The web flow (signInWithOAuth in the same WebView) doesn't work on
// Android/iOS native: the OAuth provider redirects back to
// `https://localhost/m/` (Capacitor's WebView origin) which the device
// can't route back into the app. So the native path uses a Chrome
// Custom Tab (Capacitor Browser) for the sign-in, and a custom URL
// scheme (com.rudrans.invoice://oauth-callback) to bring the user back
// into the app with the auth code.
//
// Flow:
//   1. Login screen calls startOAuth("google" | "azure")
//   2. We ask Supabase for the OAuth URL with skipBrowserRedirect = true
//   3. Browser.open() launches the URL in a Chrome Custom Tab
//   4. User signs in; provider redirects to com.rudrans.invoice://oauth-callback?code=...
//   5. Android resolves that intent to our app (intent-filter in
//      AndroidManifest.xml)
//   6. App.tsx's appUrlOpen listener calls handleDeepLink() below,
//      which extracts the `code` param and calls
//      supabase.auth.exchangeCodeForSession() — that persists the
//      session and the onAuthStateChange subscriber updates the UI.
//
// External setup required (one-time, per Supabase project):
//   - Supabase Studio → Auth → URL Configuration → Redirect URLs:
//     add `com.rudrans.invoice://oauth-callback`
//   - Google Cloud Console → OAuth client → Authorized redirect URIs:
//     add `https://api.rudrans.com/auth/v1/callback` (Supabase's
//     intermediate) — the custom scheme isn't accepted by Google
//     directly; Supabase brokers it.
//   - Microsoft Entra → App registration → Redirect URIs:
//     add the same Supabase callback URL.

import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { supabase } from "./supabase";

const NATIVE_REDIRECT = "com.rudrans.invoice://oauth-callback";

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

  await Browser.open({ url: data.url, presentationStyle: "popover" });
}

/// Called by App.tsx when Android delivers a `com.rudrans.invoice://` deep
/// link. Extracts the PKCE `code` from the URL and exchanges it with
/// Supabase for a session. Returns true if a session was established.
export async function handleDeepLink(url: string): Promise<boolean> {
  // URL shape: com.rudrans.invoice://oauth-callback?code=XXX&state=YYY
  // (Implicit-flow URLs would have a #access_token=... fragment; PKCE
  // uses query params. supabase-js v2 defaults to PKCE.)
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
