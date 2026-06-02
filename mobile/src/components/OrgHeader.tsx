// Persistent chip at the top of Camera / Recent screens that shows
// **which organisation this upload will land in**. Critical for users
// who belong to multiple orgs — wrong-org uploads are silent data
// errors otherwise.
//
// Single-org users: tappable but the picker just shows the one row.
// Multi-org users: tap to switch, persists across sessions.

import { useEffect, useState } from "react";
import { listMyOrgs, getActiveOrg, setActiveOrg, type OrgMembership } from "../lib/org-context";

interface Props {
  // Bumps when the active org changes so parent screens can reload
  // their per-org data (credentials list, recent invoices).
  onChange?: (orgId: string) => void;
}

export default function OrgHeader({ onChange }: Props) {
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [active, setActive] = useState<OrgMembership | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    (async () => {
      const list = await listMyOrgs();
      setOrgs(list);
      const a = await getActiveOrg(list);
      setActive(a);
      if (a) onChange?.(a.org_id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (org: OrgMembership) => {
    await setActiveOrg(org.org_id);
    setActive(org);
    setPicking(false);
    onChange?.(org.org_id);
  };

  if (!active) return null;
  const multi = orgs.length > 1;

  return (
    <>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 16px",
        background: "#13171e",
        borderBottom: "1px solid #1f242c",
        fontSize: 12,
      }}>
        <span style={{ color: "#6b7280", fontSize: 11 }}>📁 Uploading to</span>
        <button
          onClick={() => multi && setPicking(true)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: multi ? "#1a1f27" : "transparent",
            border: multi ? "1px solid #2a313c" : "none",
            color: "#fff", padding: multi ? "4px 10px" : "4px 0",
            borderRadius: 999, fontSize: 12, fontWeight: 500,
            cursor: multi ? "pointer" : "default",
          }}
        >
          {active.org_name}
          {multi && <span style={{ color: "#6b7280", fontSize: 10 }}>▼ switch</span>}
        </button>
        {multi && (
          <span style={{ marginLeft: "auto", color: "#6b7280", fontSize: 10 }}>
            {orgs.length} orgs
          </span>
        )}
      </div>

      {picking && (
        <div
          onClick={() => setPicking(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "flex-end", zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#13171e", width: "100%",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #1f242c" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>Switch organisation</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                The next photo lands in whichever org you pick.
              </div>
            </div>
            {orgs.map((o) => (
              <button
                key={o.org_id}
                onClick={() => pick(o)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "14px 20px",
                  background: "transparent", border: "none",
                  borderBottom: "1px solid #1f242c",
                  color: "#fff", fontSize: 14, cursor: "pointer", textAlign: "left",
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{o.org_name}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>Role: {o.role}</div>
                </div>
                {o.org_id === active.org_id && <span style={{ color: "#22d3a2", fontSize: 16 }}>✓</span>}
              </button>
            ))}
            <button
              onClick={() => setPicking(false)}
              style={{
                display: "block", width: "100%", padding: "14px",
                background: "transparent", border: "none",
                color: "#9ba3af", fontSize: 13, cursor: "pointer",
              }}
            >Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
