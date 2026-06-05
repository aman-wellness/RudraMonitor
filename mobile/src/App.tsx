// App shell: auth gate + routing + global "captured image" buffer that
// Camera → Preview share. We avoid stuffing a 700 KB base64 in the URL,
// so the captured photo lives in React state on the App root and
// Preview pulls it on mount.

import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { App as CapacitorApp } from "@capacitor/app";
import { supabase } from "./lib/supabase";
import { tryQuickUnlock } from "./lib/biometric";
import { handleDeepLink } from "./lib/oauth";
import Login from "./screens/Login";
import CameraScreen from "./screens/Camera";
import Preview from "./screens/Preview";
import Recent from "./screens/Recent";
import Settings from "./screens/Settings";
import TabBar from "./components/TabBar";

export interface CapturedImage {
  base64: string;             // raw base64 (no data: prefix)
  mime: string;               // 'image/jpeg' typically
  width: number;
  height: number;
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [captured, setCaptured] = useState<CapturedImage | null>(null);

  // 1. Try biometric quick-unlock on first mount (only if no live session
  //    is restored from localStorage). 2. Subscribe to auth changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // getSession() can hang on broken navigator.locks (older Android
      // WebViews). Race it against a short timer so the Splash screen
      // never gets stuck on cold start, no matter the device.
      const sessionRace = Promise.race([
        supabase.auth.getSession(),
        new Promise<{ data: { session: null } }>((resolve) =>
          setTimeout(() => resolve({ data: { session: null } }), 8000),
        ),
      ]);
      const { data } = await sessionRace;
      if (cancelled) return;
      if (data.session) {
        setSession(data.session);
        return;
      }
      // No persisted session — try biometric quick-unlock.
      try {
        const creds = await tryQuickUnlock();
        if (creds && !cancelled) {
          const r = await Promise.race([
            supabase.auth.signInWithPassword({ email: creds.email, password: creds.password }),
            new Promise<{ data: { session: null } }>((resolve) =>
              setTimeout(() => resolve({ data: { session: null } }), 15000),
            ),
          ]);
          if (!cancelled) setSession((r as { data: { session: Session | null } }).data.session ?? null);
          return;
        }
      } catch (bioErr) {
        console.warn("biometric quick-unlock failed:", bioErr);
      }
      if (!cancelled) setSession(null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));

    // Native OAuth deep-link bridge. When the user finishes signing in
    // through the Chrome Custom Tab, the provider redirects to
    // com.wellnessextract.invoice://oauth-callback?code=... — Android resolves
    // that intent to this app (intent-filter in AndroidManifest.xml),
    // Capacitor delivers it here as an `appUrlOpen` event, and we
    // exchange the code for a session. onAuthStateChange above then
    // picks up the new session and re-renders the routes.
    let urlListenerHandle: { remove: () => Promise<void> } | undefined;
    void CapacitorApp.addListener("appUrlOpen", (event) => {
      void handleDeepLink(event.url).catch((e) => {
        console.error("deep link auth failed:", e);
      });
    }).then((h) => { urlListenerHandle = h; });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      void urlListenerHandle?.remove();
    };
  }, []);

  // Still booting (showing splash via Capacitor + this empty paint).
  if (session === undefined) return <Splash />;

  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
      <Route element={session ? <SignedInLayout /> : <Navigate to="/login" replace />}>
        <Route path="/"        element={<CameraScreen onCaptured={setCaptured} />} />
        <Route path="/preview" element={<Preview captured={captured} onClear={() => setCaptured(null)} />} />
        <Route path="/recent"  element={<Recent />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function SignedInLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  // Preview is full-screen modal-like; hide tab bar there.
  const hideTabs = useMemo(() => location.pathname === "/preview", [location.pathname]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <SubRoutes />
      </div>
      {!hideTabs && <TabBar onNavigate={navigate} active={location.pathname} />}
    </div>
  );
}

// React Router doesn't pass parent <Route> children when using element-only
// outlets unless we use <Outlet/>. Cleaner here to render via Outlet:
import { Outlet } from "react-router-dom";
function SubRoutes() { return <Outlet />; }

function Splash() {
  return (
    <div style={{
      height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0f1115", color: "#9ba3af", fontSize: 13,
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 600, fontSize: 18, color: "#fff", marginBottom: 4 }}>Wellness Extract Invoice</div>
        <div>Loading…</div>
      </div>
    </div>
  );
}
