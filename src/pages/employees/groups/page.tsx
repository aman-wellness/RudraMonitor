import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

type Group = {
  id: string;
  org_id: string;
  provider: 'm365' | 'google';
  external_id: string;
  group_type: string;
  display_name: string | null;
  mail: string | null;
  description: string | null;
  visibility: string | null;
  is_team: boolean;
  owners_count: number;
  members_count: number;
  is_writable: boolean | null;
  writable_reason: string | null;
};
type DirUser = {
  id: string;
  org_id: string;
  provider: 'm365' | 'google';
  external_id: string;
  upn: string | null;
  display_name: string | null;
  account_enabled: boolean | null;
};
type GroupMember = {
  group_id: string;
  external_user_id: string;
  role: 'member' | 'owner';
};

const TYPE_META: Record<string, { label: string; tint: string }> = {
  m365_group: { label: 'M365 Group', tint: 'bg-blue-500/15 text-blue-400' },
  team: { label: 'Team', tint: 'bg-violet-500/15 text-violet-400' },
  security: { label: 'Security', tint: 'bg-emerald-500/15 text-emerald-400' },
  distribution: { label: 'Distribution', tint: 'bg-cyan-500/15 text-cyan-400' },
  shared_mailbox: { label: 'Shared MB', tint: 'bg-amber-500/15 text-amber-400' },
  sharepoint_site: { label: 'SP Site', tint: 'bg-rose-500/15 text-rose-400' },
  google_group: { label: 'Google', tint: 'bg-amber-500/15 text-amber-400' },
};

export default function GroupsManager() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<DirUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<'all' | 'm365' | 'google'>('all');
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: g }, { data: u }] = await Promise.all([
      supabase.from('directory_groups').select('*').order('display_name'),
      supabase.from('directory_users').select('*').order('display_name'),
    ]);
    setGroups((g ?? []) as Group[]);
    setUsers((u ?? []) as DirUser[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const userByExt = useMemo(() => {
    const m = new Map<string, DirUser>();
    for (const u of users) m.set(`${u.provider}:${u.external_id}`, u);
    return m;
  }, [users]);

  const filteredGroups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return groups.filter((g) => {
      if (providerFilter !== 'all' && g.provider !== providerFilter) return false;
      if (typeFilter !== 'all' && g.group_type !== typeFilter) return false;
      if (!ql) return true;
      return (g.display_name ?? '').toLowerCase().includes(ql) || (g.mail ?? '').toLowerCase().includes(ql);
    });
  }, [groups, q, typeFilter, providerFilter]);

  const openGroup = async (g: Group) => {
    setActiveGroup(g);
    const { data } = await supabase
      .from('directory_group_members')
      .select('group_id, external_user_id, role')
      .eq('group_id', g.id);
    setMembers((data ?? []) as GroupMember[]);
  };

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Groups, Teams & Shared Mailboxes</h1>
            <p className="text-sm text-gray-400">Mirror of M365/Google groups. Edits write to the provider first, then update locally.</p>
          </div>
          <button onClick={() => setBulkOpen(true)} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
            <i className="ri-magic-line mr-1" /> Manage user's group memberships
          </button>
        </header>

        <div className="bg-dark-800 border border-dark-700 rounded-xl">
          <div className="p-4 flex flex-col md:flex-row gap-3 md:items-center border-b border-dark-700">
            <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
              <i className="ri-search-line text-gray-500 text-sm mr-2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search group name or mail…"
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
            </div>
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value as typeof providerFilter)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none">
              <option value="all">All providers</option>
              <option value="m365">Microsoft 365</option>
              <option value="google">Google</option>
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none">
              <option value="all">All types</option>
              {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-dark-700">
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">Mail</th>
                  <th className="px-4 py-3 text-right font-medium">Members</th>
                  <th className="px-4 py-3 text-right font-medium">Owners</th>
                  <th className="px-4 py-3 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
                ) : filteredGroups.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-500">No groups. Run a sync from Integrations.</td></tr>
                ) : filteredGroups.map((g) => {
                  const meta = TYPE_META[g.group_type] ?? { label: g.group_type, tint: 'bg-dark-700 text-gray-300' };
                  return (
                    <tr key={g.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                      <td className="px-4 py-3 text-white">{g.display_name ?? '—'}</td>
                      <td className="px-4 py-3"><span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.tint}`}>{meta.label}</span></td>
                      <td className="px-4 py-3 text-gray-300">{g.mail ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-300 text-right">{g.members_count}</td>
                      <td className="px-4 py-3 text-gray-300 text-right">{g.owners_count}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => openGroup(g)} className="text-xs text-emerald-400 hover:text-emerald-300">Manage →</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {activeGroup && (
        <GroupDrawer
          group={activeGroup}
          members={members}
          allUsers={users.filter((u) => u.provider === activeGroup.provider)}
          userByExt={userByExt}
          onClose={() => setActiveGroup(null)}
          onChanged={async () => { await load(); if (activeGroup) await openGroup(activeGroup); }}
        />
      )}

      {bulkOpen && (
        <BulkAssignModal
          users={users}
          groups={groups}
          onClose={() => setBulkOpen(false)}
          onDone={async () => { setBulkOpen(false); await load(); }}
        />
      )}
    </DashboardLayout>
  );
}

// ============== Group drawer (members & owners) ==============

function GroupDrawer({
  group, members, allUsers, userByExt, onClose, onChanged,
}: {
  group: Group;
  members: GroupMember[];
  allUsers: DirUser[];
  userByExt: Map<string, DirUser>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<'member' | 'owner'>('member');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const currentMembers = members.filter((m) => m.role === 'member');
  const currentOwners = members.filter((m) => m.role === 'owner');

  const inGroup = new Set(members.map((m) => `${m.external_user_id}:${m.role}`));
  const candidates = allUsers.filter((u) => !inGroup.has(`${u.external_id}:${addRole}`));

  const mutate = async (ops: Array<{ user_id: string; action: 'add' | 'remove'; role: 'member' | 'owner' }>) => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/group-membership-mutate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: ops.map((o) => ({ group_id: group.id, ...o })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const failed = (j.results as Array<{ ok: boolean; error?: string }>).filter((x) => !x.ok);
      if (failed.length) setErr(failed.map((f) => f.error).join('; '));
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-md bg-dark-800 border-l border-dark-700 overflow-y-auto">
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wider">{group.provider} · {group.group_type}</p>
            <h2 className="text-lg text-white font-semibold truncate">{group.display_name}</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400">
            <i className="ri-close-line" />
          </button>
        </header>

        <div className="p-5 space-y-5">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-white font-medium">Add</h3>
            </div>
            <div className="flex gap-2">
              <select value={addRole} onChange={(e) => setAddRole(e.target.value as typeof addRole)}
                className="bg-dark-900 border border-dark-700 rounded-lg px-2 py-1.5 text-xs text-white">
                <option value="member">member</option>
                <option value="owner">owner</option>
              </select>
              <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)}
                className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-2 py-1.5 text-xs text-white">
                <option value="">— pick a user —</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.display_name ?? u.upn} · {u.upn}</option>)}
              </select>
              <button
                disabled={!addUserId || busy}
                onClick={() => { mutate([{ user_id: addUserId, action: 'add', role: addRole }]); setAddUserId(''); }}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs text-white"
              >Add</button>
            </div>
          </section>

          <MembersSection
            title={`Owners (${currentOwners.length})`}
            members={currentOwners}
            userByExt={userByExt}
            provider={group.provider}
            onRemove={(uid) => mutate([{ user_id: uid, action: 'remove', role: 'owner' }])}
            busy={busy}
          />
          <MembersSection
            title={`Members (${currentMembers.length})`}
            members={currentMembers}
            userByExt={userByExt}
            provider={group.provider}
            onRemove={(uid) => mutate([{ user_id: uid, action: 'remove', role: 'member' }])}
            busy={busy}
          />
        </div>
      </aside>
    </div>
  );
}

function MembersSection({
  title, members, userByExt, provider, onRemove, busy,
}: {
  title: string;
  members: GroupMember[];
  userByExt: Map<string, DirUser>;
  provider: 'm365' | 'google';
  onRemove: (userId: string) => void;
  busy: boolean;
}) {
  return (
    <section>
      <h3 className="text-sm text-white font-medium mb-2">{title}</h3>
      {members.length === 0 ? (
        <p className="text-xs text-gray-500">None</p>
      ) : (
        <ul className="space-y-1">
          {members.map((m) => {
            const u = userByExt.get(`${provider}:${m.external_user_id}`);
            return (
              <li key={`${m.role}-${m.external_user_id}`} className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-dark-900/60 rounded-lg">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{u?.display_name ?? m.external_user_id}</p>
                  <p className="text-xs text-gray-500 truncate">{u?.upn ?? '—'}</p>
                </div>
                <button
                  disabled={!u || busy}
                  onClick={() => u && onRemove(u.id)}
                  className="text-xs text-rose-400 hover:text-rose-300 disabled:opacity-30"
                >Remove</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ============== Bulk manage: one user → many groups (add + remove via diff) ==============

function BulkAssignModal({
  users, groups, onClose, onDone,
}: {
  users: DirUser[];
  groups: Group[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [userId, setUserId] = useState('');
  // The set of group_ids the user SHOULD be a member of after submit. Starts
  // equal to currently-member-in groups when a user is picked, so unchecking
  // = remove, checking new = add. Submit computes the symmetric diff.
  const [desired, setDesired] = useState<Set<string>>(new Set());
  const [originalMemberIn, setOriginalMemberIn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'member' | 'not_member'>('all');

  const selectedUser = users.find((u) => u.id === userId);

  // When a user is picked, load all their existing memberships from the
  // directory_group_members mirror so we can pre-check + compute the diff.
  useEffect(() => {
    if (!selectedUser) { setOriginalMemberIn(new Set()); setDesired(new Set()); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('directory_group_members')
        .select('group_id, role')
        .eq('external_user_id', selectedUser.external_id);
      if (cancelled) return;
      const memberIn = new Set<string>(
        (data ?? []).filter((r) => r.role === 'member').map((r) => r.group_id as string),
      );
      setOriginalMemberIn(memberIn);
      setDesired(new Set(memberIn));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedUser]);

  const eligibleGroups = useMemo(() => {
    if (!selectedUser) return [];
    const ql = q.trim().toLowerCase();
    return groups.filter((g) => {
      if (g.provider !== selectedUser.provider) return false;
      if (ql && !(g.display_name ?? '').toLowerCase().includes(ql)) return false;
      const isMember = originalMemberIn.has(g.id);
      if (filter === 'member' && !isMember) return false;
      if (filter === 'not_member' && isMember) return false;
      return true;
    });
  }, [groups, selectedUser, q, filter, originalMemberIn]);

  // Diff: groups to add (in desired but not originally member), groups to
  // remove (originally member but not in desired).
  const toAdd = useMemo(
    () => [...desired].filter((id) => !originalMemberIn.has(id)),
    [desired, originalMemberIn],
  );
  const toRemove = useMemo(
    () => [...originalMemberIn].filter((id) => !desired.has(id)),
    [desired, originalMemberIn],
  );

  const toggle = (gid: string) => {
    setDesired((s) => {
      const next = new Set(s);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  };

  const submit = async () => {
    if (!userId || (toAdd.length === 0 && toRemove.length === 0)) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const ops = [
        ...toAdd.map((gid)    => ({ group_id: gid, user_id: userId, action: 'add'    as const, role: 'member' as const })),
        ...toRemove.map((gid) => ({ group_id: gid, user_id: userId, action: 'remove' as const, role: 'member' as const })),
      ];
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/group-membership-mutate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const failed = (j.results as Array<{ ok: boolean; error?: string }>).filter((x) => !x.ok);
      if (failed.length) setErr(`${failed.length} of ${ops.length} ops failed: ${failed.slice(0, 3).map((f) => f.error).join('; ')}`);
      else { await onDone(); return; }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const groupNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.display_name ?? '—');
    return m;
  }, [groups]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg text-white font-semibold">Manage group memberships</h2>
            <p className="text-xs text-gray-500">Check to add, uncheck to remove. Submit applies the diff.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400">
            <i className="ri-close-line" />
          </button>
        </header>

        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">User</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white">
              <option value="">— pick a directory user —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name ?? u.upn} · {u.provider} · {u.upn}</option>)}
            </select>
          </label>

          {selectedUser && (
            <>
              <div className="flex gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter groups by name…"
                  className="flex-1 px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600" />
                <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}
                  className="px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white">
                  <option value="all">All groups</option>
                  <option value="member">Member only</option>
                  <option value="not_member">Not a member</option>
                </select>
              </div>

              <div className="border border-dark-700 rounded-lg max-h-72 overflow-y-auto">
                {loading ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">Loading current memberships…</p>
                ) : eligibleGroups.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">No groups match.</p>
                ) : eligibleGroups.map((g) => {
                  const meta = TYPE_META[g.group_type] ?? { label: g.group_type, tint: 'bg-dark-700 text-gray-300' };
                  const isMember = originalMemberIn.has(g.id);
                  const isChecked = desired.has(g.id);
                  const willChange = isMember !== isChecked;
                  const readOnly = g.is_writable === false;
                  return (
                    <label key={g.id}
                      title={readOnly ? `Read-only: ${g.writable_reason ?? 'managed outside Microsoft Graph'}` : undefined}
                      className={`flex items-center gap-3 px-3 py-2 border-b border-dark-700/50 hover:bg-dark-700/30 ${
                        readOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                      } ${willChange && !readOnly ? (isChecked ? 'bg-emerald-500/5' : 'bg-rose-500/5') : ''}`}>
                      <input type="checkbox" checked={isChecked} disabled={readOnly} onChange={() => !readOnly && toggle(g.id)} />
                      <span className="text-sm text-white flex-1 truncate">{g.display_name}</span>
                      {readOnly && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
                          Read-only
                        </span>
                      )}
                      {willChange && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          isChecked ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'
                        }`}>
                          {isChecked ? '+ add' : '− remove'}
                        </span>
                      )}
                      {!willChange && isMember && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-gray-400">member</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.tint}`}>{meta.label}</span>
                    </label>
                  );
                })}
              </div>

              {(toAdd.length > 0 || toRemove.length > 0) && (
                <div className="text-xs text-gray-400 space-y-1 px-1">
                  {toAdd.length > 0 && (
                    <p>
                      <span className="text-emerald-400">Will add ({toAdd.length}):</span>{' '}
                      {toAdd.slice(0, 3).map((id) => groupNameById.get(id)).join(', ')}
                      {toAdd.length > 3 && ` +${toAdd.length - 3} more`}
                    </p>
                  )}
                  {toRemove.length > 0 && (
                    <p>
                      <span className="text-rose-400">Will remove ({toRemove.length}):</span>{' '}
                      {toRemove.slice(0, 3).map((id) => groupNameById.get(id)).join(', ')}
                      {toRemove.length > 3 && ` +${toRemove.length - 3} more`}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-dark-700 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {toAdd.length === 0 && toRemove.length === 0
              ? 'No changes'
              : `${toAdd.length} to add, ${toRemove.length} to remove`}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
            <button
              onClick={submit}
              disabled={!userId || (toAdd.length === 0 && toRemove.length === 0) || busy}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium"
            >
              {busy ? 'Applying…' : `Apply ${toAdd.length + toRemove.length} change${toAdd.length + toRemove.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
