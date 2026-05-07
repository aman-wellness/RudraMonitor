import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Status = {
  enrolled: boolean;
  agent_name: string | null;
  machine_name: string | null;
  org_id: string | null;
  supabase_configured: boolean;
  last_sync: string | null;
  last_error: string | null;
  paused: boolean;
  autostart_enabled: boolean;
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Enrollment inputs
  const [licenseKey, setLicenseKey] = useState("");
  const [agentName, setAgentName] = useState("");

  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const s = await invoke<Status>("get_status");
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const onEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await invoke("enroll", {
        args: { license_key: licenseKey.trim(), agent_name: agentName.trim() },
      });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    try {
      await invoke("sign_out");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="app"><div className="muted">Loading…</div></div>;
  }

  return (
    <div className="app">
      <div className="brand">
        <span className="brand-dot" />
        TrackForce Agent
      </div>

      {error && <div className="error">{error}</div>}

      {!status.enrolled && (
        <div className="card">
          <h2>Enroll This Machine</h2>
          <p className="muted">Get the license key from your admin (Setup page in dashboard).</p>
          <form onSubmit={onEnroll} style={{ marginTop: 12 }}>
            <div className="field">
              <label>Organization License Key</label>
              <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="hex token from /setup" required />
            </div>
            <div className="field">
              <label>Employee / Agent name</label>
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g. Rahul Sharma" required />
            </div>
            <button type="submit" disabled={busy}>{busy ? "Enrolling…" : "Enroll"}</button>
          </form>
        </div>
      )}

      {status.enrolled && (
        <>
          <div className="card">
            <h2>
              <span className={`dot-status ${status.paused ? "dot-off" : status.last_error ? "dot-off" : "dot-on"}`} />
              {status.paused ? "Paused" : "Active"}
            </h2>
            <p className="muted">
              {status.paused ? "Monitoring paused. Tray menu → Resume to continue." : "Reporting metrics every 60 seconds."}
            </p>
            <div style={{ marginTop: 12 }}>
              <div className="row"><span className="k">Agent</span><span className="v">{status.agent_name}</span></div>
              <div className="row"><span className="k">Machine</span><span className="v">{status.machine_name}</span></div>
              <div className="row"><span className="k">Org</span><span className="v">{status.org_id?.slice(0, 8)}…</span></div>
              <div className="row"><span className="k">Last sync</span>
                <span className="v">{status.last_sync ? new Date(status.last_sync).toLocaleTimeString() : "—"}</span>
              </div>
              {status.last_error && (
                <div className="row"><span className="k">Last error</span><span className="v" style={{ color: "var(--danger)" }}>{status.last_error}</span></div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Settings</h2>
            <div className="row" style={{ borderTop: 0 }}>
              <span className="k">Pause monitoring</span>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={status.paused}
                  onChange={async (e) => { await invoke("set_paused", { paused: e.target.checked }); await refresh(); }}
                />
              </label>
            </div>
            <div className="row">
              <span className="k">Start at login</span>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={status.autostart_enabled}
                  onChange={async (e) => {
                    try {
                      await invoke("set_autostart", { enabled: e.target.checked });
                      await refresh();
                    } catch (err) { setError(String(err)); }
                  }}
                />
              </label>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              Closing this window keeps the agent running in the system tray.
            </p>
          </div>

          <button className="ghost" onClick={onSignOut} disabled={busy}>Sign out</button>
        </>
      )}
    </div>
  );
}
