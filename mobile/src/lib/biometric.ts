// Thin wrapper around `capacitor-native-biometric`.
//
// Flow:
//   1. After a successful password login, call `saveCredentials(email, password)`.
//      Plugin encrypts them in iOS Keychain / Android KeyStore behind
//      Face ID / fingerprint.
//   2. On subsequent app cold starts, call `tryQuickUnlock()`. If
//      biometric succeeds, returns the saved credentials; caller runs
//      `supabase.auth.signInWithPassword` silently.
//   3. On sign-out, call `clearCredentials()` to wipe.
//
// Falls back gracefully on devices without biometric (older Android,
// rooted, lockscreen-disabled) — `isAvailable()` returns false and the
// caller just shows the regular login screen.

import { NativeBiometric, BiometryType } from "capacitor-native-biometric";
import { Preferences } from "@capacitor/preferences";

const SERVER = "com.rudrans.invoice";
const PREF_KEY = "biometric_enabled";

export async function isAvailable(): Promise<boolean> {
  try {
    const r = await NativeBiometric.isAvailable();
    return r.isAvailable && r.biometryType !== BiometryType.NONE;
  } catch { return false; }
}

export async function isEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: PREF_KEY });
  return value === "1";
}

export async function saveCredentials(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await NativeBiometric.setCredentials({ username: email, password, server: SERVER });
    await Preferences.set({ key: PREF_KEY, value: "1" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function tryQuickUnlock(): Promise<{ email: string; password: string } | null> {
  if (!(await isEnabled())) return null;
  if (!(await isAvailable())) return null;
  try {
    await NativeBiometric.verifyIdentity({
      reason: "Unlock Rudrans Invoice",
      title: "Rudrans Invoice",
      subtitle: "Sign in with biometrics",
      description: "Use Face ID / fingerprint to continue",
    });
    const creds = await NativeBiometric.getCredentials({ server: SERVER });
    if (!creds.username || !creds.password) return null;
    return { email: creds.username, password: creds.password };
  } catch {
    // User cancelled or biometric failed — fall back to login screen.
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  try { await NativeBiometric.deleteCredentials({ server: SERVER }); } catch { /* ignore */ }
  await Preferences.remove({ key: PREF_KEY });
}
