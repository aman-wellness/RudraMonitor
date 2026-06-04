import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import ModalShell from './ModalShell';
import { RolePill } from './Pill';
import type { GovPillar, GovPillarAssignment, GovRole, OrgUser } from '../types';

interface Props {
  pillar: GovPillar;
  users: OrgUser[];
  existing: GovPillarAssignment[];
  onSaved: () => void;
  onClose: () => void;
}

interface DraftAssignment {
  employee_id: string;
  role: GovRole;
  is_acting: boolean;
}

const ROLE_OPTIONS: GovRole[] = ['owner', 'admin', 'editor', 'view', 'external'];

export default function AssignRoleModal({ pillar, users, existing, onSaved, onClose }: Props) {
  // Seed drafts with the existing assignments so the modal acts as "edit set"
  // rather than "add only".
  const [drafts, setDrafts] = useState<DraftAssignment[]>(
    existing.map((a) => ({ employee_id: a.employee_id, role: a.role, is_acting: a.is_acting })),
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftMap = useMemo(() => {
    const m = new Map<string, DraftAssignment>();
    for (const d of drafts) m.set(`${d.employee_id}|${d.role}`, d);
    return m;
  }, [drafts]);

  const filteredUsers = useMemo(() => {
    if (!search) return users.slice(0, 50);
    const q = search.toLowerCase();
    return users
      .filter((u) => u.display_name.toLowerCase().includes(q) || (u.work_email ?? '').toLowerCase().includes(q))
      .slice(0, 50);
  }, [users, search]);

  const toggle = (employee_id: string, role: GovRole) => {
    setDrafts((prev) => {
      const key = `${employee_id}|${role}`;
      const has = prev.some((d) => `${d.employee_id}|${d.role}` === key);
      if (has) return prev.filter((d) => `${d.employee_id}|${d.role}` !== key);
      return [...prev, { employee_id, role, is_acting: false }];
    });
  };

  const setActing = (employee_id: string, role: GovRole, value: boolean) => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.employee_id === employee_id && d.role === role ? { ...d, is_acting: value } : d,
      ),
    );
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-assignment-save`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        pillar_id: pillar.id,
        assignments: drafts,
        replace: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body?.error ?? `HTTP ${res.status}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={`Assign roles — ${pillar.name}`}
      subtitle="Pick people + role. Same person can hold multiple roles on a pillar (e.g. Editor + Acting Admin)."
      maxWidthClass="max-w-2xl"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : `Save ${drafts.length} assignment${drafts.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      {error && <div className="mb-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}

      {/* Current drafts summary */}
      {drafts.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Selected ({drafts.length})</p>
          <div className="space-y-1 max-h-40 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 p-2">
            {drafts.map((d) => {
              const u = users.find((x) => x.employee_id === d.employee_id);
              return (
                <div key={`${d.employee_id}|${d.role}`} className="flex items-center justify-between gap-2 text-sm px-2 py-1">
                  <span className="text-gray-200 flex-1 truncate">
                    {u?.display_name ?? '(unknown)'}
                  </span>
                  <RolePill role={d.role} />
                  <label className="flex items-center gap-1 text-[10px] text-gray-500">
                    <input
                      type="checkbox"
                      checked={d.is_acting}
                      onChange={(e) => setActing(d.employee_id, d.role, e.target.checked)}
                    />
                    acting
                  </label>
                  <button
                    onClick={() => toggle(d.employee_id, d.role)}
                    className="text-gray-500 hover:text-rose-400 text-xs"
                  >Remove</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Picker */}
      <div className="flex items-center gap-2 mb-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search employees…"
          className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm"
        />
      </div>
      <div className="max-h-72 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700">
        {filteredUsers.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-500">No matches.</div>
        )}
        {filteredUsers.map((u) => {
          if (!u.employee_id) return null;
          return (
            <div key={u.row_id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-200">{u.display_name}</span>
                <span className="text-[10px] text-gray-500 truncate">{u.work_email}</span>
              </div>
              <div className="flex gap-2 mt-1 flex-wrap">
                {ROLE_OPTIONS.map((role) => {
                  const checked = draftMap.has(`${u.employee_id}|${role}`);
                  return (
                    <button
                      key={role}
                      onClick={() => toggle(u.employee_id!, role)}
                      className={`text-[10px] uppercase font-semibold tracking-wider px-2 py-[3px] rounded border ${
                        checked
                          ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-200'
                          : 'bg-dark-800 border-dark-700 text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {role}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
