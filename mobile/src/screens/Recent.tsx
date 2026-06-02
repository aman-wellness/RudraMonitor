// Recent invoices — read-only list of the last 20 invoices in the
// caller's org (any source: API / email / scrape / mobile / manual).
// Tap a row → open the attached file in a signed URL.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import OrgHeader from "../components/OrgHeader";

interface InvoiceRow {
  id: string;
  platform_name: string | null;
  invoice_number: string | null;
  issue_date: string | null;
  amount: number | null;
  currency: string | null;
  status: string;
  source: string;
  attachment_path: string | null;
  pdf_url: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  paid:     "#22d3a2",
  pending:  "#f59e0b",
  overdue:  "#ef4444",
  failed:   "#ef4444",
  refunded: "#9ba3af",
  draft:    "#60a5fa",
};

export default function Recent() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);

  const load = async (orgId: string | null) => {
    setLoading(true);
    setErr(null);
    try {
      let q = supabase
        .from("v_credential_invoices")
        .select("id, platform_name, invoice_number, issue_date, amount, currency, status, source, attachment_path, pdf_url, created_at, org_id")
        .order("created_at", { ascending: false })
        .limit(20);
      if (orgId) q = q.eq("org_id", orgId);
      const { data, error } = await q;
      if (error) throw error;
      setRows((data ?? []) as InvoiceRow[]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(activeOrgId); }, [activeOrgId]);

  const open = async (r: InvoiceRow) => {
    setOpeningId(r.id);
    try {
      let url = r.pdf_url ?? "";
      if (!url && r.attachment_path) {
        const { data } = await supabase.storage
          .from("credential-invoices")
          .createSignedUrl(r.attachment_path, 60 * 5);
        url = data?.signedUrl ?? "";
      }
      if (url) window.open(url, "_blank");
      else alert("No file attached to this invoice");
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)", background: "#0f1115" }}>
      <OrgHeader onChange={(id) => setActiveOrgId(id)} />
      <header style={{ padding: "14px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Recent invoices</h1>
        <button onClick={() => void load(activeOrgId)} style={{ background: "transparent", border: "none", color: "#22d3a2", fontSize: 12, cursor: "pointer" }}>Refresh</button>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>
        {loading ? (
          <p style={{ color: "#9ba3af", fontSize: 13, textAlign: "center", marginTop: 40 }}>Loading…</p>
        ) : err ? (
          <p style={{ color: "#fca5a5", fontSize: 12, textAlign: "center", marginTop: 40 }}>{err}</p>
        ) : rows.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 13, textAlign: "center", marginTop: 40 }}>
            No invoices yet. Snap one from the Capture tab.
          </p>
        ) : rows.map((r) => (
          <button
            key={r.id}
            onClick={() => open(r)}
            disabled={openingId === r.id}
            style={{
              display: "flex", width: "100%", textAlign: "left",
              background: "#13171e", border: "1px solid #1f242c",
              borderRadius: 12, padding: "12px 14px", marginBottom: 8,
              color: "#fff", cursor: "pointer",
              alignItems: "center", gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.platform_name ?? "Unassigned"}
                </span>
                <span style={{ fontSize: 13, color: "#9ba3af", fontVariantNumeric: "tabular-nums" }}>
                  {r.amount != null ? `${r.currency ?? ""} ${Number(r.amount).toLocaleString()}` : "—"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "#6b7280" }}>
                <span>{r.invoice_number ?? "no #"} · {r.issue_date ?? "—"}</span>
                <span style={{ color: STATUS_COLORS[r.status] ?? "#6b7280", fontWeight: 500 }}>{r.status}</span>
              </div>
            </div>
            <span style={{ fontSize: 16, color: "#374151" }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
