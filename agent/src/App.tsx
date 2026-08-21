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
  prefilled_agent_name: string | null;
  license_present: boolean;
  license_blocked: boolean;
  license_reason: string | null;
  backend_url: string | null;
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
    // If the launcher script pre-filled a name, prefer it over whatever the user typed
    // (the input is hidden in that case anyway).
    const effectiveName = (status?.prefilled_agent_name ?? agentName).trim();
    try {
      await invoke("enroll", {
        args: { license_key: licenseKey.trim(), agent_name: effectiveName },
      });
      await refresh();
    } catch (err) {
      setError(String(err));
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
        Security Assistant
      </div>

      {error && <div className="error">{error}</div>}

      {!status.enrolled && (
        <div className="card">
          <h2>{status.prefilled_agent_name ? `Welcome, ${status.prefilled_agent_name}` : 'Enroll This Machine'}</h2>
          <p className="muted">
            {status.prefilled_agent_name
              ? 'Just paste the License Key your admin shared and click Enroll.'
              : 'Get the license key from your admin (Setup page in dashboard).'}
          </p>
          {/* Which backend this build will send the key to. A stale agent.json
              overrides the URL compiled into the installer, so this is the only
              place the operator can tell a "wrong server" from a "wrong key" —
              the server's answer to both is the same sentence. */}
          {status.backend_url && (
            <p className="muted" style={{ fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
              Server: {status.backend_url}
            </p>
          )}
          <form onSubmit={onEnroll} style={{ marginTop: 12 }}>
            <div className="field">
              <label>Organization License Key</label>
              <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="hex token from /setup" required />
            </div>
            {!status.prefilled_agent_name && (
              <div className="field">
                <label>Employee / Agent name</label>
                <input value={agentName} onChange={(e) => setAgentName(e.target.value)}
                  placeholder="e.g. Rahul Sharma" required />
              </div>
            )}
            <button type="submit" disabled={busy}>{busy ? "Enrolling…" : "Enroll"}</button>
          </form>
        </div>
      )}

      {status.enrolled && (
        <>
          {(status.license_blocked || !status.license_present) && (
            <div className="card" style={{ borderColor: "var(--danger)" }}>
              <h2 style={{ color: "var(--danger)" }}>
                {status.license_blocked ? "License Blocked" : "License Required"}
              </h2>
              <p className="muted">
                {status.license_blocked
                  ? `Captures paused: ${status.license_reason ?? "license invalid"}.`
                  : "Enter your license key to start monitoring. Get this from your reseller or admin."}
              </p>
              <LicenseInput onSet={refresh} />
            </div>
          )}
          <div className="card">
            <h2>
              <span className={`dot-status ${status.paused ? "dot-off" : status.last_error ? "dot-off" : "dot-on"}`} />
              {status.paused ? "Paused" : status.license_blocked ? "License Blocked" : "Active"}
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

        </>
      )}
    </div>
  );
}

function LicenseInput({ onSet }: { onSet: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    try {
      await invoke("set_license_key", { licenseKey: key.trim() });
      setKey("");
      onSet();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <input
        type="text"
        placeholder="License key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        style={{ width: "100%", padding: 8, fontFamily: "monospace", fontSize: 12 }}
      />
      <button onClick={submit} disabled={busy || !key.trim()} style={{ marginTop: 8, width: "100%" }}>
        {busy ? "Validating…" : "Activate"}
      </button>
      {err && <p className="muted" style={{ color: "var(--danger)", marginTop: 6 }}>{err}</p>}
    </div>
  );
}
