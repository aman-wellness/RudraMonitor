import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { RolePill } from './Pill';
import AccessGrantModal from './AccessGrantModal';
import type { GovPillar, GovPillarPlatform, GovAccessRegister, OrgUser, GovRole } from '../types';

// ── Platform Manager ──────────────────────────────────────────────────────
// Full CRUD for governance platforms with deep credentials-vault integration.
//
// Each platform card shows, in one view:
//   • Platform name + type + ownership email + IT-registered status
//   • Linked credential from vault (username, last rotated, category)
//   • Who has access (Access Register rows — per-person role + level)
//   • Add / Edit / Delete platform
//   • Add access entry, mark reviewed, revoke
//
// Designed for the Amazon-4-marketplaces + Shopify-multi-store use case the
// customer described: list every platform variant, see who has access, link
// to the password vault.

interface CredentialOption {
  id: string;
  platform_name: string;
  category: string | null;
  username: string | null;
  active: boolean;
  last_rotated_at: string | null;
}

interface Props {
  platforms: GovPillarPlatform[];
  pillars: GovPillar[];
  accessRows: GovAccessRegister[];
  users: OrgUser[];
  canEdit: boolean;
  onEditPlatform: (id: string | null, defaultPillarId?: string) => void;
  onReload: () => void;
}

const LEVEL_ORDER: Record<GovRole, number> = { owner: 0, admin: 1, editor: 2, view: 3, external: 4 };
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;

export default function PlatformManager({
  platforms, pillars, accessRows, users, canEdit, onEditPlatform, onReload,
}: Props) {
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [filterPillarId, setFilterPillarId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [grantingFor, setGrantingFor] = useState<GovPillarPlatform | null>(null);

  useEffect(() => {
    supabase.from('credentials_safe')
      .select('id, platform_name, category, username, active, last_rotated_at')
      .order('platform_name')
      .then(({ data }) => setCredentials((data ?? []) as CredentialOption[]));
  }, []);

  const credById = useMemo(() => {
    const m = new Map<string, CredentialOption>();
    for (const c of credentials) m.set(c.id, c);
    return m;
  }, [credentials]);

  const pillarById = useMemo(() => {
    const m = new Map<string, GovPillar>();
    for (const p of pillars) m.set(p.id, p);
    return m;
  }, [pillars]);

  const userById = useMemo(() => {
    const m = new Map<string, OrgUser>();
    for (const u of users) if (u.employee_id) m.set(u.employee_id, u);
    return m;
  }, [users]);

  const accessByPlatform = useMemo(() => {
    const m = new Map<string, GovAccessRegister[]>();
    for (const a of accessRows) {
      const arr = m.get(a.platform_id) ?? [];
      arr.push(a);
      m.set(a.platform_id, arr);
    }
    return m;
  }, [accessRows]);

  // Filter + search.
  const filteredPlatforms = useMemo(() => {
    let out = platforms;
    if (filterPillarId) out = out.filter((p) => p.pillar_id === filterPillarId);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((p) =>
        p.platform_name.toLowerCase().includes(q) ||
        (p.platform_type ?? '').toLowerCase().includes(q) ||
        (p.ownership_email ?? '').toLowerCase().includes(q));
    }
    return out;
  }, [platforms, filterPillarId, search]);

  // Group by pillar for the section headers.
  const grouped = useMemo(() => {
    const m = new Map<string | null, GovPillarPlatform[]>();
    for (const p of filteredPlatforms) {
      const arr = m.get(p.pillar_id) ?? [];
      arr.push(p);
      m.set(p.pillar_id, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => {
      const an = pillarById.get(a ?? '')?.sort_order ?? 999;
      const bn = pillarById.get(b ?? '')?.sort_order ?? 999;
      return an - bn;
    });
  }, [filteredPlatforms, pillarById]);

  const handleDelete = async (platformId: string) => {
    if (!confirm('Delete this platform? Linked access register rows will be removed.')) return;
    // RLS lets writers delete. Cascades to gov_access_register via FK on delete cascade.
    const { error } = await supabase.from('gov_pillar_platforms').delete().eq('id', platformId);
    if (error) { alert(`Delete failed: ${error.message}`); return; }
    onReload();
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search platforms…"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white"
          />
        </div>
        <select
          value={filterPillarId}
          onChange={(e) => setFilterPillarId(e.target.value)}
          className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200"
        >
          <option value="">All pillars</option>
          {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {canEdit && (
          <button
            onClick={() => onEditPlatform(null, filterPillarId || undefined)}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold whitespace-nowrap"
          >
            <i className="ri-add-line mr-1" /> Add platform
          </button>
        )}
      </div>

      {/* Empty state */}
      {filteredPlatforms.length === 0 && (
        <div className="rounded-xl border border-dashed border-dark-700 bg-dark-900/40 p-10 text-center text-sm text-gray-500">
          {platforms.length === 0
            ? (canEdit ? 'No platforms yet. Click "Add platform" to register the first one.' : 'No platforms documented yet.')
            : 'No platforms match your search.'}
        </div>
      )}

      {/* Grouped by pillar */}
      {grouped.map(([pillarId, items]) => {
        const pillar = pillarId ? pillarById.get(pillarId) : null;
        return (
          <div key={pillarId ?? 'no-pillar'} className="space-y-2">
            {pillar && (
              <div className="flex items-center gap-2 mt-4">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: pillar.color }} />
                <h3 className="text-xs uppercase tracking-wider font-semibold text-gray-300">{pillar.name}</h3>
                <span className="text-[10px] text-gray-500">· {items.length} platform{items.length === 1 ? '' : 's'}</span>
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {items.map((p) => {
                const cred = p.credential_id ? credById.get(p.credential_id) : null;
                const access = (accessByPlatform.get(p.id) ?? []).sort((a, b) => LEVEL_ORDER[a.access_level] - LEVEL_ORDER[b.access_level]);
                const overdue = access.filter((a) => !a.last_reviewed_at || (Date.now() - new Date(a.last_reviewed_at).getTime()) > SIX_MONTHS_MS).length;
                return (
                  <div key={p.id} className="rounded-xl border border-dark-700 bg-dark-900/40 overflow-hidden hover:border-dark-600 transition">
                    {/* Card header */}
                    <div
                      className="px-4 py-3 border-b border-dark-700 flex items-start gap-3"
                      style={pillar ? { background: `linear-gradient(90deg, ${pillar.color}15, transparent)` } : undefined}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold text-white truncate">{p.platform_name}</h4>
                          {p.platform_type && <span className="text-[10px] uppercase tracking-wider text-gray-500 font-mono">{p.platform_type}</span>}
                        </div>
                        {p.ownership_email && (
                          <a
                            href={`mailto:${p.ownership_email}`}
                            className="inline-block mt-1 font-mono text-[11px] bg-blue-500/10 text-blue-300 border border-blue-500/30 rounded px-2 py-[2px] truncate hover:bg-blue-500/20"
                          >
                            {p.ownership_email}
                          </a>
                        )}
                      </div>
                      {canEdit && (
                        <div className="flex flex-col gap-1">
                          <button
                            onClick={() => onEditPlatform(p.id)}
                            className="text-xs text-emerald-400 hover:text-emerald-300"
                          >Edit</button>
                          <button
                            onClick={() => handleDelete(p.id)}
                            className="text-xs text-rose-400 hover:text-rose-300"
                          >Delete</button>
                        </div>
                      )}
                    </div>

                    {/* Linked credential */}
                    <div className="px-4 py-3 border-b border-dark-700 bg-dark-900/30">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 font-semibold">Credentials Vault</div>
                      {cred ? (
                        <div className="flex items-center gap-3 text-xs">
                          <i className="ri-key-2-line text-blue-400 text-lg" />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-blue-300 truncate">{cred.username ?? '(no username)'}</div>
                            <div className="text-gray-500">
                              {cred.category ? `${cred.category} · ` : ''}
                              {cred.last_rotated_at
                                ? `rotated ${new Date(cred.last_rotated_at).toLocaleDateString()}`
                                : 'never rotated'}
                            </div>
                          </div>
                          <a href="/employees/credentials" className="text-[10px] text-emerald-400 hover:underline whitespace-nowrap">
                            Open vault →
                          </a>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 italic">Not linked to vault</span>
                          {canEdit && (
                            <button
                              onClick={() => onEditPlatform(p.id)}
                              className="text-[10px] text-blue-400 hover:underline"
                            >Link credential →</button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Access list */}
                    <div className="px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                          Who has access ({access.length})
                          {overdue > 0 && (
                            <span className="ml-2 text-amber-400 normal-case font-normal">
                              · {overdue} overdue review
                            </span>
                          )}
                        </div>
                        {canEdit && (
                          <button
                            onClick={() => setGrantingFor(p)}
                            className="text-[10px] text-emerald-400 hover:underline"
                          >+ Grant access</button>
                        )}
                      </div>
                      {access.length === 0 ? (
                        <p className="text-xs text-gray-600 italic">No one assigned yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {access.slice(0, 5).map((a) => {
                            const u = a.employee_id ? userById.get(a.employee_id) : null;
                            const ageMs = a.last_reviewed_at ? (Date.now() - new Date(a.last_reviewed_at).getTime()) : Infinity;
                            const isOverdue = ageMs > SIX_MONTHS_MS;
                            return (
                              <li key={a.id} className="flex items-center gap-2 text-xs">
                                <span className="flex-1 truncate text-gray-200">
                                  <span className="text-gray-400 text-[10px] uppercase mr-1">{a.role_label}</span>
                                  {u?.display_name ?? <span className="text-amber-400 italic">Hiring</span>}
                                </span>
                                <RolePill role={a.access_level} />
                                {isOverdue && (
                                  <span title="Last reviewed > 6 months ago" className="text-amber-400 text-[10px]">
                                    <i className="ri-time-line" />
                                  </span>
                                )}
                              </li>
                            );
                          })}
                          {access.length > 5 && (
                            <li className="text-[10px] text-gray-500 italic pl-2">+ {access.length - 5} more — view all in Section 05</li>
                          )}
                        </ul>
                      )}
                    </div>

                    {/* IT-registered footer */}
                    <div className="px-4 py-2 border-t border-dark-700 bg-dark-900/60 flex items-center justify-between text-[10px]">
                      <span className={p.it_registered ? 'text-emerald-400' : 'text-gray-500'}>
                        <i className={p.it_registered ? 'ri-check-double-line' : 'ri-time-line'} /> IT {p.it_registered ? 'registered' : 'pending'}
                      </span>
                      {pillar && (
                        <span className="text-gray-500">{pillar.name}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {grantingFor && (
        <AccessGrantModal
          platform={grantingFor}
          users={users}
          existing={accessByPlatform.get(grantingFor.id) ?? []}
          onSaved={() => { setGrantingFor(null); onReload(); }}
          onClose={() => setGrantingFor(null)}
        />
      )}
    </div>
  );
}
