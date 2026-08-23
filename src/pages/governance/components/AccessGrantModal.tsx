import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { notify } from '@/lib/notify';
import ModalShell from './ModalShell';
import { RolePill } from './Pill';
import type { GovPillarPlatform, GovAccessRegister, GovRole, OrgUser } from '../types';

interface Props {
  platform: GovPillarPlatform;
  users: OrgUser[];
  existing: GovAccessRegister[];
  onSaved: () => void;
  onClose: () => void;
}

interface Draft {
  id?: string;           // existing row id
  employee_id: string | null;
  role_label: string;
  email_format: string;
  access_level: GovRole;
  removed?: boolean;
}

const LEVELS: GovRole[] = ['owner', 'admin', 'editor', 'view', 'external'];

export default function AccessGrantModal({ platform, users, existing, onSaved, onClose }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(
    existing.map((a) => ({
      id: a.id,
      employee_id: a.employee_id,
      role_label: a.role_label,
      email_format: a.email_format ?? '',
      access_level: a.access_level,
    })),
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const employeesInDraft = useMemo(() => new Set(drafts.filter((d) => !d.removed).map((d) => d.employee_id ?? '')), [drafts]);

  const filteredUsers = useMemo(() => {
    let list = users.filter((u) => u.employee_id);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((u) =>
        u.display_name.toLowerCase().includes(q) || (u.work_email ?? '').toLowerCase().includes(q));
    }
    return list.slice(0, 40);
  }, [users, search]);

  const addPerson = (u: OrgUser) => {
    if (!u.employee_id) return;
    if (employeesInDraft.has(u.employee_id)) return;
    setDrafts((prev) => [
      ...prev,
      {
        employee_id: u.employee_id,
        role_label: u.display_name.split(' ')[0] ?? 'Member',
        email_format: u.work_email ?? '',
        access_level: 'editor',
      },
    ]);
  };

  const addVacant = () => {
    setDrafts((prev) => [
      ...prev,
      {
        employee_id: null,
        role_label: 'Hiring',
        email_format: '',
        access_level: 'editor',
      },
    ]);
  };

  const updateDraft = (idx: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const removeDraft = (idx: number) => {
    setDrafts((prev) => {
      const d = prev[idx];
      if (d.id) return prev.map((x, i) => (i === idx ? { ...x, removed: true } : x));
      return prev.filter((_, i) => i !== idx);
    });
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;

    // Delete removed rows directly via PostgREST (RLS gates).
    const toDelete = drafts.filter((d) => d.removed && d.id).map((d) => d.id!) as string[];
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase.from('gov_access_register').delete().in('id', toDelete);
      if (delErr) { setError(delErr.message); setSaving(false); return; }
    }

    // Save + insert via the edge function.
    const rows = drafts.filter((d) => !d.removed).map((d) => ({
      id: d.id,
      platform_id: platform.id,
      employee_id: d.employee_id,
      role_label: d.role_label || 'Member',
      email_format: d.email_format || null,
      access_level: d.access_level,
    }));
    if (rows.length > 0) {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-access-register-save`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ rows }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    onSaved();
  };

  const markAllReviewed = async () => {
    const ids = drafts.filter((d) => d.id && !d.removed).map((d) => d.id!) as string[];
    if (ids.length === 0) return;
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-access-register-save`;
    // Audit M28: check the response before reporting success. This previously
    // called onSaved() unconditionally, so a failed "mark reviewed" (4xx/5xx)
    // was shown to the user as done — a silent no-op on a compliance surface.
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ row_ids: ids, mark_reviewed: true }),
      });
    } catch (e) {
      notify.error('Failed to mark reviewed', { description: String((e as Error).message) });
      return;
    }
    if (!resp.ok) {
      notify.error('Failed to mark reviewed', { description: `Server returned ${resp.status}` });
      return;
    }
    onSaved();
  };

  const visibleDrafts = drafts.filter((d) => !d.removed);

  return (
    <ModalShell
      title={`Access — ${platform.platform_name}`}
      subtitle="Track everyone with access. Vacant rows (no employee selected) document seats currently hiring."
      maxWidthClass="max-w-3xl"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          {visibleDrafts.some((d) => d.id) && (
            <button onClick={markAllReviewed} className="px-3 py-2 text-sm text-amber-300 hover:text-amber-200">
              <i className="ri-check-double-line mr-1" /> Mark all reviewed
            </button>
          )}
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : `Save (${visibleDrafts.length} ${visibleDrafts.length === 1 ? 'entry' : 'entries'})`}
          </button>
        </>
      )}
    >
      {error && <div className="mb-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}

      {/* Drafts editor table */}
      {visibleDrafts.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-lg border border-dark-700">
          <table className="w-full text-xs">
            <thead className="bg-dark-900/60">
              <tr className="text-left text-[9px] uppercase tracking-wider text-gray-500">
                <th className="px-2 py-2">Role label</th>
                <th className="px-2 py-2">Person</th>
                <th className="px-2 py-2">Email format</th>
                <th className="px-2 py-2 w-32">Access level</th>
                <th className="px-2 py-2 w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-700">
              {drafts.map((d, idx) => {
                if (d.removed) return null;
                const u = d.employee_id ? users.find((x) => x.employee_id === d.employee_id) : null;
                return (
                  <tr key={idx} className="hover:bg-dark-800/40">
                    <td className="px-2 py-1.5">
                      <input
                        value={d.role_label}
                        onChange={(e) => updateDraft(idx, { role_label: e.target.value })}
                        className="w-full bg-dark-900 border border-dark-700 rounded px-2 py-1 text-white"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-gray-200">
                      {u ? u.display_name : <span className="text-amber-400 italic">Hiring (vacant)</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={d.email_format}
                        onChange={(e) => updateDraft(idx, { email_format: e.target.value })}
                        placeholder="user@company.com or 'MCC Link'"
                        className="w-full bg-dark-900 border border-dark-700 rounded px-2 py-1 text-blue-300 font-mono text-[11px]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={d.access_level}
                        onChange={(e) => updateDraft(idx, { access_level: e.target.value as GovRole })}
                        className="w-full bg-dark-900 border border-dark-700 rounded px-2 py-1 text-white"
                      >
                        {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => removeDraft(idx)} className="text-gray-500 hover:text-rose-400 text-xs">
                        <i className="ri-close-line" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Picker */}
      <div className="flex items-center gap-2 mb-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search employees to add…"
          className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm"
        />
        <button
          onClick={addVacant}
          className="px-3 py-2 text-xs text-amber-300 hover:text-amber-200 border border-amber-500/30 rounded-lg whitespace-nowrap"
        >
          + Vacant seat
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700">
        {filteredUsers.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-500">No matches.</div>
        )}
        {filteredUsers.map((u) => {
          const already = employeesInDraft.has(u.employee_id ?? '');
          return (
            <button
              key={u.row_id}
              disabled={already}
              onClick={() => addPerson(u)}
              className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition ${
                already ? 'opacity-50 cursor-default' : 'hover:bg-dark-800/40 cursor-pointer'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200">{u.display_name}</div>
                <div className="text-[10px] text-gray-500 truncate">{u.work_email}</div>
              </div>
              {already ? <RolePill role="view" /> : <i className="ri-add-line text-emerald-400" />}
            </button>
          );
        })}
      </div>
    </ModalShell>
  );
}
