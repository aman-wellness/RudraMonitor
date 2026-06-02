// Preview screen — shows the captured photo at the top, fires
// invoice-extract while the user looks at it, then renders the
// extracted fields in an editable form. Save uploads the JPEG to the
// `credential-invoices` bucket and calls invoice-save with the fields.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, SUPABASE_URL } from "../lib/supabase";
import { listMyOrgs, getActiveOrg } from "../lib/org-context";
import type { CapturedImage } from "../App";
import FieldRow from "../components/FieldRow";

interface Props {
  captured: CapturedImage | null;
  onClear: () => void;
}

interface Extracted {
  invoice_number: string | null;
  issue_date: string | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  status: "paid" | "pending" | "overdue" | "failed" | "refunded" | "draft" | null;
  vendor_name: string | null;
  vendor_domain: string | null;
  notes: string | null;
}

interface CredOption { id: string; platform_name: string; org_id: string }

const STATUSES: Array<NonNullable<Extracted["status"]>> = ["paid", "pending", "overdue", "failed", "refunded", "draft"];
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AUD", "CAD", "SGD"];

export default function Preview({ captured, onClear }: Props) {
  const navigate = useNavigate();

  // Form state
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [status, setStatus] = useState<NonNullable<Extracted["status"]>>("pending");
  const [credId, setCredId] = useState("");
  const [notes, setNotes] = useState("");

  // Extract + creds
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredOption[]>([]);

  // Save
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  const ranRef = useRef(false);            // prevent double-call under StrictMode

  const [orgName, setOrgName] = useState<string>("");

  useEffect(() => {
    if (!captured) {
      navigate("/", { replace: true });
      return;
    }
    (async () => {
      // 1. Resolve the active org (set by OrgHeader on Camera screen).
      const orgs = await listMyOrgs();
      const active = await getActiveOrg(orgs);
      if (active) {
        setOrgId(active.org_id);
        setOrgName(active.org_name);
      }
      // 2. Load credentials in that org for the vendor-match dropdown.
      let q = supabase.from("credentials_safe")
        .select("id, platform_name, org_id")
        .eq("active", true);
      if (active) q = q.eq("org_id", active.org_id);
      const { data } = await q;
      setCredentials((data ?? []) as CredOption[]);
    })();
    if (ranRef.current) return;
    ranRef.current = true;
    void runExtract(captured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runExtract = async (img: CapturedImage) => {
    setExtracting(true);
    setExtractMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${SUPABASE_URL}/functions/v1/invoice-extract`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pdf_base64: img.base64, mime_type: img.mime }),
      });
      const j = await r.json() as { ok?: boolean; extracted?: Extracted; matched_credential_id?: string; matched_credential_platform?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const ex = j.extracted ?? {} as Partial<Extracted>;
      if (ex.invoice_number) setInvoiceNumber(ex.invoice_number);
      if (ex.issue_date) setIssueDate(ex.issue_date);
      if (ex.period_start) setPeriodStart(ex.period_start);
      if (ex.period_end) setPeriodEnd(ex.period_end);
      if (ex.amount != null) setAmount(String(ex.amount));
      if (ex.currency) setCurrency(ex.currency);
      if (ex.status) setStatus(ex.status);
      if (ex.notes) setNotes(ex.notes);
      if (j.matched_credential_id) setCredId(j.matched_credential_id);
      setExtractMsg(
        j.matched_credential_platform
          ? `✓ Matched to ${j.matched_credential_platform}`
          : ex.vendor_name
            ? `✓ Read: ${ex.vendor_name} (no credential match)`
            : "✓ Fields filled",
      );
    } catch (e) {
      setExtractMsg(`⚠ Couldn't read invoice — fill manually. (${(e as Error).message})`);
    } finally {
      setExtracting(false);
    }
  };

  const dataUri = useMemo(() => captured ? `data:${captured.mime};base64,${captured.base64}` : null, [captured]);
  const isPdf = captured?.mime === "application/pdf";

  const retake = () => {
    onClear();
    navigate("/", { replace: true });
  };

  const save = async () => {
    if (!captured) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();

      // 1. Upload the JPEG to storage so the web dashboard can preview it.
      const folder = credId || "_unassigned";
      const resolvedOrg = orgId
        ?? credentials.find((c) => c.id === credId)?.org_id
        ?? credentials[0]?.org_id;
      if (!resolvedOrg) throw new Error("No org found — sign in again");
      // Extension matches mime so HEAD requests serve the right Content-
      // Type when the file is later previewed via signed URL.
      const ext = extForMime(captured.mime);
      const objectKey = `${resolvedOrg}/${folder}/${crypto.randomUUID()}.${ext}`;
      const bytes = base64ToBytes(captured.base64);
      const { error: upErr } = await supabase.storage
        .from("credential-invoices")
        .upload(objectKey, bytes, {
          contentType: captured.mime,
          upsert: false,
          cacheControl: "3600",
        });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      // 2. Create the invoice row via invoice-save.
      const r = await fetch(`${SUPABASE_URL}/functions/v1/invoice-save`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          credential_id: credId || null,
          invoice_number: invoiceNumber || null,
          issue_date: issueDate || null,
          period_start: periodStart || null,
          period_end: periodEnd || null,
          amount: amount === "" ? null : Number(amount),
          currency,
          status,
          notes: notes || null,
          attachment_path: objectKey,
          attachment_mime: captured.mime,
          attachment_name: `mobile-${Date.now()}.${ext}`,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);

      // Success — clear buffer + bounce back to camera.
      onClear();
      navigate("/", { replace: true });
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!captured) return null;

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top)",
      paddingBottom: "env(safe-area-inset-bottom)",
      background: "#0f1115",
    }}>
      <header style={{
        padding: "10px 16px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid #1f242c",
      }}>
        <button onClick={retake} style={iconBtn}>← Retake</button>
        <div style={{ fontSize: 13, color: "#9ba3af", textAlign: "center" }}>
          <div>Confirm details</div>
          {orgName && (
            <div style={{ fontSize: 10, color: "#22d3a2", marginTop: 2 }}>
              → {orgName}
            </div>
          )}
        </div>
        <button onClick={save} disabled={saving || extracting} style={{
          ...iconBtn, color: saving || extracting ? "#6b7280" : "#22d3a2", fontWeight: 600,
        }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {dataUri && (
          <div style={{
            background: "#13171e", borderRadius: 12, overflow: "hidden",
            border: "1px solid #1f242c",
          }}>
            {isPdf ? (
              <div style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "18px 18px",
              }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 10,
                  background: "rgba(239,68,68,0.12)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 28,
                }}>📄</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "#fff", fontWeight: 500 }}>PDF document</div>
                  <div style={{ fontSize: 11, color: "#9ba3af", marginTop: 2 }}>
                    {((captured.base64.length * 0.75) / 1024).toFixed(0)} KB · ready to extract
                  </div>
                </div>
                <a
                  href={dataUri}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, color: "#22d3a2", textDecoration: "none" }}
                >View →</a>
              </div>
            ) : (
              <img src={dataUri} alt="Invoice" style={{ width: "100%", display: "block", maxHeight: 240, objectFit: "cover" }} />
            )}
          </div>
        )}

        <div style={{
          padding: "10px 12px",
          borderRadius: 10,
          background: extracting ? "rgba(34,211,162,0.08)" : (extractMsg?.startsWith("⚠") ? "rgba(245,158,11,0.08)" : "rgba(34,211,162,0.08)"),
          border: `1px solid ${extracting ? "#22d3a233" : (extractMsg?.startsWith("⚠") ? "#f59e0b33" : "#22d3a233")}`,
          fontSize: 12, color: "#9ba3af",
        }}>
          {extracting ? "🪄 Reading invoice with Claude…" : (extractMsg ?? "")}
        </div>

        <FieldRow label="Invoice number" value={invoiceNumber} onChange={setInvoiceNumber} placeholder="INV-…" />
        <FieldRow label="Issue date" value={issueDate} onChange={setIssueDate} type="date" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FieldRow label="Period start" value={periodStart} onChange={setPeriodStart} type="date" />
          <FieldRow label="Period end" value={periodEnd} onChange={setPeriodEnd} type="date" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
          <FieldRow label="Amount" value={amount} onChange={setAmount} type="number" placeholder="0.00" />
          <label>
            <div style={lblStyle}>Currency</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={selectStyle}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label>
            <div style={lblStyle}>Status</div>
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={selectStyle}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <label>
          <div style={lblStyle}>Platform / credential</div>
          <select value={credId} onChange={(e) => setCredId(e.target.value)} style={selectStyle}>
            <option value="">— Unassigned —</option>
            {credentials.map((c) => <option key={c.id} value={c.id}>{c.platform_name}</option>)}
          </select>
        </label>

        <label>
          <div style={lblStyle}>Notes (optional)</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ ...selectStyle, resize: "none", fontFamily: "inherit" }}
            placeholder="Any context"
          />
        </label>

        {saveErr && (
          <div style={{
            padding: "10px 12px", borderRadius: 10,
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            fontSize: 12, color: "#fca5a5",
          }}>{saveErr}</div>
        )}

        <button
          onClick={save}
          disabled={saving || extracting}
          style={{
            marginTop: 4,
            padding: "14px",
            background: "#22d3a2",
            color: "#0f1115",
            border: "none",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 600,
            opacity: saving || extracting ? 0.5 : 1,
            cursor: saving || extracting ? "wait" : "pointer",
          }}
        >
          {saving ? "Saving invoice…" : "Save invoice"}
        </button>
      </div>
    </div>
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extForMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png")  return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif")  return "gif";
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  return "jpg";
}

const iconBtn: React.CSSProperties = {
  background: "transparent", border: "none", color: "#9ba3af",
  fontSize: 14, padding: 4, cursor: "pointer",
};
const lblStyle: React.CSSProperties = {
  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
  color: "#6b7280", marginBottom: 4,
};
const selectStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px",
  background: "#1a1f27", border: "1px solid #2a313c", borderRadius: 8,
  color: "#fff", fontSize: 14, outline: "none",
};
