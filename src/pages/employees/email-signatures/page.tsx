// Email Signatures — centralized Outlook signature management.
//
// One active HTML template per org, rendered per-user against directory_users
// fields ({{firstName}}, {{title}}, {{phone}}, …), then pushed to each
// selected M365 user's mailbox via the signatures-push edge function.
//
// Design intentionally uses a plain <textarea> for HTML (with a live preview)
// rather than pulling in tiptap/lexical — customers overwhelmingly paste
// signatures designed in Word or an external signature-designer tool.
// Keeping this a plain HTML editor also matches how CodeTwo and Exclaimer
// present the same feature.

import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type SignatureTemplate = {
  id: string;
  org_id: string;
  name: string;
  html_body: string;
  auto_add_new_message: boolean;
  auto_add_reply_forward: boolean;
  auto_add_mobile: boolean;
  is_active: boolean;
  updated_at: string;
};

type DirectoryUser = {
  external_id: string;
  upn: string;
  display_name: string | null;
  given_name: string | null;
  surname: string | null;
  job_title: string | null;
  department: string | null;
  mail: string | null;
  office_phone: string | null;
  mobile_phone: string | null;
  account_enabled: boolean;
};

type PushStatus = {
  template_id: string;
  upn: string;
  state: 'pending' | 'applied' | 'failed' | 'skipped';
  applied_at: string | null;
  last_error: string | null;
  updated_at: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Token metadata (single source of truth for the token pill row + preview)
// Names MUST match the render map in supabase/functions/signatures-push/index.ts.
// ─────────────────────────────────────────────────────────────────────────────
const TOKENS: Array<{ key: string; label: string; example: string }> = [
  { key: 'firstName',   label: 'First name',   example: 'Priya' },
  { key: 'lastName',    label: 'Last name',    example: 'Sharma' },
  { key: 'fullName',    label: 'Full name',    example: 'Priya Sharma' },
  { key: 'title',       label: 'Job title',    example: 'Senior Product Manager' },
  { key: 'department',  label: 'Department',   example: 'Product' },
  { key: 'email',       label: 'Email',        example: 'priya@example.com' },
  { key: 'phone',       label: 'Phone',        example: '+91 98765 43210' },
  { key: 'mobilePhone', label: 'Mobile',       example: '+91 98765 43210' },
  { key: 'officePhone', label: 'Office phone', example: '+91 11 2345 6789' },
  { key: 'office',      label: 'Office',       example: 'Delhi HQ' },
  { key: 'city',        label: 'City',         example: 'New Delhi' },
  { key: 'country',     label: 'Country',      example: 'India' },
  { key: 'companyName', label: 'Company',      example: 'Wellness Extract' },
  { key: 'website',     label: 'Website',      example: 'https://wellnessextract.com' },
];

const DEFAULT_TEMPLATE = `<table style="font-family: Arial, sans-serif; font-size: 12px; color: #333333;">
  <tr>
    <td style="padding-right: 16px; vertical-align: top;">
      <strong style="font-size: 14px; color: #111827;">{{fullName}}</strong><br>
      <span style="color: #6b7280;">{{title}}{{department}}</span><br>
      <span style="color: #6b7280;">{{companyName}}</span>
    </td>
    <td style="border-left: 2px solid #2563eb; padding-left: 16px; vertical-align: top;">
      <span>📧 <a href="mailto:{{email}}" style="color: #2563eb; text-decoration: none;">{{email}}</a></span><br>
      <span>📱 {{mobilePhone}}</span><br>
      <span>🌐 <a href="{{website}}" style="color: #2563eb; text-decoration: none;">{{website}}</a></span>
    </td>
  </tr>
</table>`;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function EmailSignaturesPage() {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  const [template, setTemplate] = useState<SignatureTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);

  // Draft state (uncommitted edits). Keeps the "Save" button meaningful.
  const [draftHtml, setDraftHtml] = useState('');
  const [draftName, setDraftName] = useState('Company signature');
  const [autoNew, setAutoNew] = useState(true);
  const [autoReply, setAutoReply] = useState(true);
  const [autoMobile, setAutoMobile] = useState(true);
  const [dirty, setDirty] = useState(false);

  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());  // upns
  const [previewUpn, setPreviewUpn] = useState<string>('');
  const [pushStatuses, setPushStatuses] = useState<Record<string, PushStatus>>({});
  const [busy, setBusy] = useState<'save' | 'push' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [m365Connected, setM365Connected] = useState(true);

  // ────────────────────────────────────────────────────────────────────────
  // Data loading
  // ────────────────────────────────────────────────────────────────────────
  const loadTemplate = useCallback(async () => {
    if (!orgId) return;
    setTemplateLoading(true);
    const { data } = await supabase
      .from('signature_templates')
      .select('*')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .maybeSingle();
    if (data) {
      const t = data as SignatureTemplate;
      setTemplate(t);
      setDraftHtml(t.html_body);
      setDraftName(t.name);
      setAutoNew(t.auto_add_new_message);
      setAutoReply(t.auto_add_reply_forward);
      setAutoMobile(t.auto_add_mobile);
    } else {
      setTemplate(null);
      setDraftHtml(DEFAULT_TEMPLATE);
    }
    setDirty(false);
    setTemplateLoading(false);
  }, [orgId]);

  const loadUsers = useCallback(async () => {
    if (!orgId) return;
    const [dir, integ] = await Promise.all([
      supabase.from('directory_users')
        .select('external_id, upn, display_name, given_name, surname, job_title, department, mail, office_phone, mobile_phone, account_enabled')
        .eq('org_id', orgId)
        .eq('provider', 'm365')
        .eq('account_enabled', true)
        .eq('is_shared_mailbox', false)
        .order('display_name', { ascending: true }),
      supabase.from('org_integrations_safe')
        .select('status')
        .eq('org_id', orgId)
        .eq('provider', 'm365')
        .maybeSingle(),
    ]);
    setUsers((dir.data ?? []) as DirectoryUser[]);
    setM365Connected(integ.data?.status === 'active');
    if (dir.data && dir.data.length > 0 && !previewUpn) {
      setPreviewUpn(dir.data[0].upn);
    }
  }, [orgId, previewUpn]);

  const loadStatuses = useCallback(async () => {
    if (!orgId || !template?.id) return;
    const { data } = await supabase
      .from('signature_push_status')
      .select('template_id, upn, state, applied_at, last_error, updated_at')
      .eq('org_id', orgId)
      .eq('template_id', template.id);
    const byUpn: Record<string, PushStatus> = {};
    for (const s of (data ?? []) as PushStatus[]) byUpn[s.upn] = s;
    setPushStatuses(byUpn);
  }, [orgId, template?.id]);

  useEffect(() => { void loadTemplate(); void loadUsers(); }, [loadTemplate, loadUsers]);
  useEffect(() => { void loadStatuses(); }, [loadStatuses]);

  // ────────────────────────────────────────────────────────────────────────
  // Realtime — refresh push statuses while a push is in flight
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!template?.id) return;
    const ch = supabase
      .channel(`sig-status-${template.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'signature_push_status', filter: `template_id=eq.${template.id}` },
        () => { void loadStatuses(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [template?.id, loadStatuses]);

  // ────────────────────────────────────────────────────────────────────────
  // Render preview HTML with a picked user's real data (or example values
  // if no user selected yet — happens before M365 is connected)
  // ────────────────────────────────────────────────────────────────────────
  const previewHtml = useMemo(() => {
    const previewUser = users.find((u) => u.upn === previewUpn);
    const values: Record<string, string> = {};
    for (const t of TOKENS) {
      values[t.key] = previewUser ? sampleValue(t.key, previewUser, organization?.name ?? '') : t.example;
    }
    return draftHtml.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k: string) =>
      escapeHtml(values[k] ?? ''),
    );
  }, [draftHtml, previewUpn, users, organization?.name]);

  // ────────────────────────────────────────────────────────────────────────
  // Actions
  // ────────────────────────────────────────────────────────────────────────
  const insertToken = (key: string) => {
    setDraftHtml((prev) => prev + `{{${key}}}`);
    setDirty(true);
  };

  const saveTemplate = async () => {
    if (!orgId || !draftHtml.trim()) return;
    setBusy('save');
    setMsg(null);
    try {
      if (template?.id) {
        const { error } = await supabase
          .from('signature_templates')
          .update({
            name: draftName,
            html_body: draftHtml,
            auto_add_new_message: autoNew,
            auto_add_reply_forward: autoReply,
            auto_add_mobile: autoMobile,
          })
          .eq('id', template.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('signature_templates')
          .insert({
            org_id: orgId,
            name: draftName,
            html_body: draftHtml,
            auto_add_new_message: autoNew,
            auto_add_reply_forward: autoReply,
            auto_add_mobile: autoMobile,
            is_active: true,
          });
        if (error) throw error;
      }
      await loadTemplate();
      setMsg({ kind: 'ok', text: 'Signature template saved.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const pushToSelected = async () => {
    if (!orgId || !template?.id) return;
    if (dirty) {
      setMsg({ kind: 'err', text: 'Save your changes first — push uses the saved template, not the draft.' });
      return;
    }
    const upns = selected.size > 0 ? Array.from(selected) : users.map((u) => u.upn);
    if (upns.length === 0) {
      setMsg({ kind: 'err', text: 'No M365 users to push to.' });
      return;
    }
    setBusy('push');
    setMsg({ kind: 'info', text: `Pushing to ${upns.length} user${upns.length === 1 ? '' : 's'}…` });

    // Map UPNs → employee_ids for the edge function.
    const { data: emps } = await supabase
      .from('employees')
      .select('id, work_email')
      .eq('org_id', orgId)
      .in('work_email', upns);
    const employee_ids = (emps ?? []).map((e) => e.id);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signatures-push`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: template.id,
            org_id: orgId,
            // If we couldn't map any employees, fall back to 'all' which the
            // edge function scopes to org_id via directory_users.
            employee_ids: employee_ids.length > 0 ? employee_ids : 'all',
          }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const errCode = j.error_code as string | undefined;
        if (errCode === 'exchange_auth_failed') {
          throw new Error(
            'Exchange Online authorization failed. In Azure, ensure: (1) Office 365 Exchange Online → Exchange.ManageAsApp permission is granted with admin consent, AND (2) the app has the Exchange Administrator role assigned in Entra → Roles.',
          );
        }
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setMsg({
        kind: j.failed > 0 ? 'err' : 'ok',
        text: `Applied to ${j.pushed}/${j.total} user${j.total === 1 ? '' : 's'}${j.failed > 0 ? ` — ${j.failed} failed` : ''}.`,
      });
      await loadStatuses();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggleUser = (upn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(upn)) next.delete(upn); else next.add(upn);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => prev.size === users.length ? new Set() : new Set(users.map((u) => u.upn)));
  };

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────
  if (templateLoading) {
    return (
      <DashboardLayout>
        <div className="p-6 text-gray-500">Loading…</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Email Signatures</h1>
            <p className="text-sm text-gray-500 mt-1">
              Design one company signature and push it to every Microsoft 365 user's Outlook — new email, reply, and forward.
            </p>
          </div>
        </header>

        {!m365Connected && (
          <div className="border border-amber-300 bg-amber-50 rounded-lg p-4 text-sm text-amber-900">
            <p className="font-medium">Microsoft 365 not connected</p>
            <p className="mt-1">
              Connect M365 from <a href="/employees/integrations" className="underline">Integrations</a> first — signature push runs against your tenant's mailboxes.
            </p>
          </div>
        )}

        {msg && (
          <div className={`border rounded-lg p-3 text-sm ${
            msg.kind === 'ok' ? 'border-green-300 bg-green-50 text-green-900'
              : msg.kind === 'err' ? 'border-red-300 bg-red-50 text-red-900'
              : 'border-blue-300 bg-blue-50 text-blue-900'
          }`}>
            {msg.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ─── Editor ────────────────────────────────────────────────── */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Template name</label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => { setDraftName(e.target.value); setDirty(true); }}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                placeholder="Company signature"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Insert token</label>
              <div className="flex flex-wrap gap-1.5">
                {TOKENS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => insertToken(t.key)}
                    className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-1 hover:bg-blue-100"
                    title={`Inserts {{${t.key}}} — will be replaced with each user's ${t.label.toLowerCase()}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Signature HTML
                <span className="ml-2 text-gray-400 font-normal">Paste HTML from your designer, or edit the default below.</span>
              </label>
              <textarea
                value={draftHtml}
                onChange={(e) => { setDraftHtml(e.target.value); setDirty(true); }}
                className="w-full h-72 border border-gray-300 rounded px-3 py-2 text-xs font-mono"
                spellCheck={false}
              />
            </div>

            <fieldset className="border border-gray-200 rounded p-3 space-y-2">
              <legend className="text-xs font-medium text-gray-700 px-1">Auto-apply on</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoNew} onChange={(e) => { setAutoNew(e.target.checked); setDirty(true); }} />
                <span>New emails</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoReply} onChange={(e) => { setAutoReply(e.target.checked); setDirty(true); }} />
                <span>Replies and forwards</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoMobile} onChange={(e) => { setAutoMobile(e.target.checked); setDirty(true); }} />
                <span>Outlook mobile app</span>
              </label>
            </fieldset>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={saveTemplate}
                disabled={!dirty || busy === 'save'}
                className="bg-blue-600 text-white text-sm rounded px-4 py-2 disabled:bg-gray-300"
              >
                {busy === 'save' ? 'Saving…' : template ? 'Save changes' : 'Create template'}
              </button>
              {template && dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
              {template && !dirty && <span className="text-xs text-gray-400">Saved · {new Date(template.updated_at).toLocaleString()}</span>}
            </div>
          </div>

          {/* ─── Preview ───────────────────────────────────────────────── */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-700">Live preview</label>
              {users.length > 0 && (
                <select
                  value={previewUpn}
                  onChange={(e) => setPreviewUpn(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1"
                >
                  {users.map((u) => (
                    <option key={u.upn} value={u.upn}>
                      {u.display_name ?? u.upn}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="border border-gray-200 rounded bg-gray-50 p-4 min-h-[240px] overflow-auto">
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
            <p className="text-xs text-gray-500">
              Preview uses <strong>real</strong> data from the selected user's Microsoft 365 directory row. Blank fields (no phone, no title) render as empty.
            </p>
          </div>
        </div>

        {/* ─── User selection + push ─────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Apply to users</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">
                {selected.size === 0 ? `Will push to all ${users.length} users` : `${selected.size} selected`}
              </span>
              <button
                type="button"
                onClick={pushToSelected}
                disabled={!template || busy === 'push' || users.length === 0}
                className="bg-green-600 text-white text-sm rounded px-4 py-2 disabled:bg-gray-300"
              >
                {busy === 'push' ? 'Pushing…' : 'Push signature now'}
              </button>
            </div>
          </div>

          {users.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">
              No M365 users found. {m365Connected ? 'Try a full sync from Integrations.' : 'Connect M365 first.'}
            </p>
          ) : (
            <div className="border border-gray-200 rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="p-2 w-8">
                      <input
                        type="checkbox"
                        checked={selected.size === users.length && users.length > 0}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="p-2 text-left">Name</th>
                    <th className="p-2 text-left">Email</th>
                    <th className="p-2 text-left">Title</th>
                    <th className="p-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const s = pushStatuses[u.upn];
                    return (
                      <tr key={u.upn} className="border-t border-gray-100">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={selected.has(u.upn)}
                            onChange={() => toggleUser(u.upn)}
                          />
                        </td>
                        <td className="p-2 text-gray-900">{u.display_name ?? '—'}</td>
                        <td className="p-2 text-gray-600">{u.upn}</td>
                        <td className="p-2 text-gray-600">{u.job_title ?? '—'}</td>
                        <td className="p-2">
                          <StatusPill status={s} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ─── Coverage matrix ─────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Where this signature shows up</h2>
          <ul className="space-y-1.5 text-sm text-gray-700">
            <li><span className="text-green-600 font-bold">✓</span> <strong>Outlook Web + New Outlook</strong> — applied on New / Reply / Forward, immediately after push.</li>
            <li><span className="text-green-600 font-bold">✓</span> <strong>Classic Outlook Desktop (Windows)</strong> — the moment you click <em>Push signature now</em>, the Security Assistant agent v0.6.22+ receives a realtime notification and writes the signature under the user's own name to <code className="text-xs">%APPDATA%\Microsoft\Signatures\</code> plus sets it as Outlook's default via registry. No polling, no timer — pushes only when you push.</li>
            <li><span className="text-amber-600 font-bold">△</span> <strong>Outlook Mobile app</strong> — Microsoft doesn't expose a push API for mobile. Users must set the mobile signature manually once (Outlook mobile → Settings → Signature).</li>
          </ul>
        </div>

        {/* ─── One-time Azure setup callout ──────────────────────────── */}
        <details className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-900">
            Not working? One-time Azure setup for signature push
          </summary>
          <div className="mt-3 space-y-3 text-sm text-gray-700">
            <p>Signature push uses the Exchange Online PowerShell REST API. Two one-time steps are required in Azure (done once per tenant):</p>
            <ol className="list-decimal ml-5 space-y-2">
              <li>
                <strong>Grant API permission:</strong> Azure Portal → App registrations → <em>track force</em> → API permissions → <em>+ Add a permission</em> → <em>Office 365 Exchange Online</em> → Application permissions → <code>Exchange.ManageAsApp</code>. Then click <em>Grant admin consent</em>.
              </li>
              <li>
                <strong>Assign directory role:</strong> Entra Portal → Identity → Roles &amp; admins → <em>Exchange Administrator</em> → <em>+ Add assignments</em> → change Type to <em>Service Principal</em> → search <em>track force</em> → Active + permanent → Assign.
              </li>
            </ol>
            <p className="text-xs text-gray-500">Once both are done, come back here and click <em>Push signature now</em> — it should succeed on the first try.</p>
          </div>
        </details>
      </div>
    </DashboardLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: PushStatus | undefined }) {
  if (!status) return <span className="text-xs text-gray-400">Not pushed</span>;
  if (status.state === 'applied') {
    return (
      <span className="text-xs text-green-700" title={status.applied_at ?? ''}>
        ✓ Applied
      </span>
    );
  }
  if (status.state === 'failed') {
    return (
      <span className="text-xs text-red-700" title={status.last_error ?? ''}>
        ✗ Failed <span className="text-red-500 underline">(hover)</span>
      </span>
    );
  }
  if (status.state === 'pending') return <span className="text-xs text-blue-700">…Pending</span>;
  return <span className="text-xs text-gray-500">{status.state}</span>;
}

function sampleValue(key: string, u: DirectoryUser, orgName: string): string {
  switch (key) {
    case 'firstName':   return u.given_name ?? u.display_name?.split(' ')[0] ?? '';
    case 'lastName':    return u.surname ?? '';
    case 'fullName':    return u.display_name ?? '';
    case 'title':       return u.job_title ?? '';
    case 'department':  return u.department ?? '';
    case 'email':       return u.mail ?? u.upn;
    case 'phone':       return u.office_phone ?? u.mobile_phone ?? '';
    case 'mobilePhone': return u.mobile_phone ?? '';
    case 'officePhone': return u.office_phone ?? '';
    case 'companyName': return orgName;
    default: return '';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
