// Settings — signed-in account info, biometric toggle, sign-out.
// Intentionally minimal: this is a one-feature app.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { clearCredentials, isEnabled as bioEnabled, isAvailable as bioAvailable, saveCredentials } from "../lib/biometric";
import { listMyOrgs, getActiveOrg, setActiveOrg, clearActiveOrg, type OrgMembership } from "../lib/org-context";

export default function Settings() {
  const [email, setEmail] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [activeOrg, setActiveOrgState] = useState<OrgMembership | null>(null);
  const [bioOn, setBioOn] = useState<boolean | null>(null);
  const [bioSupported, setBioSupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? null);
      const list = await listMyOrgs();
      setOrgs(list);
      setActiveOrgState(await getActiveOrg(list));
      setBioSupported(await bioAvailable());
      setBioOn(await bioEnabled());
    })();
  }, []);

  const switchOrg = async (o: OrgMembership) => {
    await setActiveOrg(o.org_id);
    setActiveOrgState(o);
  };

  const signOut = async () => {
    if (!confirm("Sign out of Wellness Extract Invoice?")) return;
    setBusy(true);
    try {
      await clearCredentials();
      await clearActiveOrg();
      await supabase.auth.signOut();
    } finally {
      setBusy(false);
    }
  };

  const toggleBio = async () => {
    if (bioOn) {
      await clearCredentials();
      setBioOn(false);
      return;
    }
    // Enabling — we need to re-prompt password since we don't keep it
    // in memory after the initial login.
    const pw = prompt("Re-enter your Wellness Extract password to enable Face ID / fingerprint quick-unlock:");
    if (!pw || !email) return;
    const r = await saveCredentials(email, pw);
    if (r.ok) setBioOn(true);
    else alert(`Could not save: ${r.error}`);
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top)",
      background: "#0f1115",
    }}>
      <header style={{ padding: "14px 20px 10px" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Account</h1>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Card>
          <Row label="Signed in as" value={email ?? "—"} />
        </Card>

        {orgs.length > 0 && (
          <Card>
            <div style={{ padding: "12px 16px 8px", borderBottom: "1px solid #1f242c" }}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                {orgs.length === 1 ? "Organisation" : `Switch organisation (${orgs.length})`}
              </div>
              <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>
                Photos you snap land in the selected org's invoice ledger.
              </div>
            </div>
            {orgs.map((o, i) => (
              <button
                key={o.org_id}
                onClick={() => orgs.length > 1 && switchOrg(o)}
                disabled={orgs.length === 1}
                style={{
                  display: "flex", width: "100%", textAlign: "left",
                  background: "transparent", border: "none",
                  borderBottom: i === orgs.length - 1 ? "none" : "1px solid #1f242c",
                  color: "#fff", padding: "12px 16px",
                  alignItems: "center", justifyContent: "space-between",
                  cursor: orgs.length > 1 ? "pointer" : "default",
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{o.org_name}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>Role: {o.role}</div>
                </div>
                {activeOrg?.org_id === o.org_id && (
                  <span style={{ color: "#22d3a2", fontSize: 18 }}>✓</span>
                )}
              </button>
            ))}
          </Card>
        )}

        {bioSupported && (
          <Card>
            <button
              onClick={toggleBio}
              style={{
                display: "flex", width: "100%", textAlign: "left",
                background: "transparent", border: "none", color: "#fff",
                padding: "14px 16px", alignItems: "center", justifyContent: "space-between",
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Face ID / fingerprint unlock</div>
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                  {bioOn === null ? "checking…" : (bioOn ? "On — quick sign-in on next launch" : "Off")}
                </div>
              </div>
              <div style={{
                width: 36, height: 22, borderRadius: 22,
                background: bioOn ? "#22d3a2" : "#2a313c",
                position: "relative", transition: "background 0.15s",
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 18, background: "#fff",
                  position: "absolute", top: 2, left: bioOn ? 16 : 2,
                  transition: "left 0.15s",
                }} />
              </div>
            </button>
          </Card>
        )}

        <Card>
          <button
            onClick={signOut}
            disabled={busy}
            style={{
              display: "block", width: "100%",
              padding: "14px 16px", textAlign: "center",
              background: "transparent", border: "none",
              color: "#fca5a5", fontSize: 14, fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </Card>

        <p style={{ marginTop: 8, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
          Wellness Extract Invoice · v0.1.0
        </p>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "#13171e", border: "1px solid #1f242c", borderRadius: 12,
      overflow: "hidden",
    }}>{children}</div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
      <span style={{ fontSize: 13, color: "#fff", maxWidth: "60%", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
