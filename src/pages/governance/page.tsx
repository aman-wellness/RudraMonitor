import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { useAppAccess } from '@/lib/useAppAccess';
import LeadershipTable from './components/LeadershipTable';
import ChannelTable from './components/ChannelTable';
import PlatformOwnershipTable from './components/PlatformOwnershipTable';
import PlatformManager from './components/PlatformManager';
import PillarDetailCard from './components/PillarDetailCard';
import AccessRegisterTable from './components/AccessRegisterTable';
import PolicyList from './components/PolicyList';
import OrgTree from './components/OrgTree';
import OrgChart, { type OrgChartEmployee, type OrgChartDepartment } from './components/OrgChart';
import PillarEditModal from './components/PillarEditModal';
import AssignRoleModal from './components/AssignRoleModal';
import PlatformEditModal from './components/PlatformEditModal';
import PolicyEditModal from './components/PolicyEditModal';
import type {
  GovPillar, GovPillarSummary, GovPillarAssignment, GovPillarPlatform,
  GovChannel, GovChannelMember, GovAccessRegister, GovPolicy, OrgUser,
} from './types';

// Six tabs mirror the source governance HTML doc's six sections.
// "org" is the default landing tab — the chart is the headline visual.
type Tab = 'org' | 'leadership' | 'platforms' | 'pillars' | 'register' | 'policies';

export default function GovernancePage() {
  const { organization } = useAuth();
  const { canEdit } = useAppAccess();
  const canWrite = canEdit('governance');
  const orgId = organization?.id ?? null;

  const [tab, setTab] = useState<Tab>('org');
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [syncingM365, setSyncingM365] = useState(false);
  const [m365SyncResult, setM365SyncResult] = useState<string | null>(null);

  // Modal state — null = closed.
  const [editingPillar, setEditingPillar] = useState<GovPillar | null | undefined>(undefined);
  const [assigningPillar, setAssigningPillar] = useState<GovPillar | null>(null);
  const [editingPlatform, setEditingPlatform] = useState<{ platform: GovPillarPlatform | null; pillarId?: string } | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<GovPolicy | null | undefined>(undefined);

  // Data buckets
  const [pillars, setPillars] = useState<GovPillar[]>([]);
  const [pillarSummary, setPillarSummary] = useState<GovPillarSummary[]>([]);
  const [assignments, setAssignments] = useState<GovPillarAssignment[]>([]);
  const [platforms, setPlatforms] = useState<GovPillarPlatform[]>([]);
  const [channels, setChannels] = useState<GovChannel[]>([]);
  const [channelMembers, setChannelMembers] = useState<GovChannelMember[]>([]);
  const [accessRows, setAccessRows] = useState<GovAccessRegister[]>([]);
  const [policies, setPolicies] = useState<GovPolicy[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [founderName, setFounderName] = useState<string | null>(null);
  // Org chart data — sourced from employees + departments (existing tables),
  // NOT from gov_pillars. Pillars are a separate optional overlay.
  const [chartEmployees, setChartEmployees] = useState<OrgChartEmployee[]>([]);
  const [chartDepartments, setChartDepartments] = useState<OrgChartDepartment[]>([]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const [
      pRes, sRes, aRes, plRes, cRes, cmRes, arRes, polRes, uRes, ownerRes,
      empRes, deptRes,
    ] = await Promise.all([
      supabase.from('gov_pillars').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('v_gov_pillars_summary').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('gov_pillar_assignments').select('*').eq('org_id', orgId),
      supabase.from('gov_pillar_platforms').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('gov_channels').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('gov_channel_members').select('*').eq('org_id', orgId),
      supabase.from('gov_access_register').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('gov_policies').select('*').eq('org_id', orgId).order('sort_order'),
      supabase.from('v_org_users')
        .select('row_id, display_name, work_email, employee_id, has_we_record')
        .eq('org_id', orgId)
        .neq('status', 'offboarded'),
      supabase.from('organizations').select('owner_user_id, name').eq('id', orgId).maybeSingle(),
      // Org chart sources: employees + departments — the existing data.
      // Filter at the query level so offboarding/offboarded/disabled never
      // hit the chart. (Chart also re-filters defensively in OrgChart.)
      supabase.from('employees')
        .select('id, full_name, designation, manager_id, department_id, status')
        .eq('org_id', orgId)
        .not('status', 'in', '("offboarding","offboarded","disabled","terminated","inactive","suspended")'),
      supabase.from('org_departments').select('id, name').eq('org_id', orgId),
    ]);
    setPillars((pRes.data ?? []) as GovPillar[]);
    setPillarSummary((sRes.data ?? []) as GovPillarSummary[]);
    setAssignments((aRes.data ?? []) as GovPillarAssignment[]);
    setPlatforms((plRes.data ?? []) as GovPillarPlatform[]);
    setChannels((cRes.data ?? []) as GovChannel[]);
    setChannelMembers((cmRes.data ?? []) as GovChannelMember[]);
    setAccessRows((arRes.data ?? []) as GovAccessRegister[]);
    setPolicies((polRes.data ?? []) as GovPolicy[]);
    setUsers((uRes.data ?? []) as OrgUser[]);

    // Resolve founder display name from organizations.owner_user_id → v_org_users
    const ownerUid = (ownerRes.data as { owner_user_id?: string | null } | null)?.owner_user_id ?? null;
    let founderEmpId: string | null = null;
    if (ownerUid) {
      const { data: ownerRow } = await supabase
        .from('v_org_users')
        .select('display_name, employee_id')
        .eq('user_id', ownerUid)
        .maybeSingle();
      const o = ownerRow as { display_name?: string; employee_id?: string } | null;
      setFounderName(o?.display_name ?? null);
      founderEmpId = o?.employee_id ?? null;
    }

    // Build the org-chart employee list — annotate the founder's row so
    // OrgChart can show the CEO · Owner label.
    const rawEmps = (empRes.data ?? []) as OrgChartEmployee[];
    setChartEmployees(rawEmps.map((e) => ({
      ...e,
      is_founder: founderEmpId !== null && e.id === founderEmpId,
    })));
    setChartDepartments((deptRes.data ?? []) as OrgChartDepartment[]);

    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  // Lookups for fast O(1) joins in the table components.
  const userById = useMemo(() => {
    const m = new Map<string, OrgUser>();
    for (const u of users) if (u.employee_id) m.set(u.employee_id, u);
    return m;
  }, [users]);

  const pillarById = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    for (const p of pillars) m.set(p.id, { name: p.name, color: p.color });
    return m;
  }, [pillars]);

  const pillarNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pillars) m.set(p.id, p.name);
    return m;
  }, [pillars]);

  const assignmentsByPillar = useMemo(() => {
    const m = new Map<string, GovPillarAssignment[]>();
    for (const a of assignments) {
      const arr = m.get(a.pillar_id) ?? [];
      arr.push(a);
      m.set(a.pillar_id, arr);
    }
    return m;
  }, [assignments]);

  const platformsByPillar = useMemo(() => {
    const m = new Map<string, GovPillarPlatform[]>();
    for (const p of platforms) {
      const arr = m.get(p.pillar_id) ?? [];
      arr.push(p);
      m.set(p.pillar_id, arr);
    }
    return m;
  }, [platforms]);

  const channelByPillar = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels) {
      if (c.primary_pillar_id && !m.has(c.primary_pillar_id)) m.set(c.primary_pillar_id, c.name);
    }
    return m;
  }, [channels]);

  const channelMemberCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const cm of channelMembers) m.set(cm.channel_id, (m.get(cm.channel_id) ?? 0) + 1);
    return m;
  }, [channelMembers]);

  // Seed defaults — calls the gov_seed_default_pillars RPC. Idempotent.
  const handleSeedDefaults = useCallback(async () => {
    if (!orgId) return;
    setSeeding(true);
    const { error } = await supabase.rpc('gov_seed_default_pillars', { p_org_id: orgId });
    if (error) {
      alert(`Seed failed: ${error.message}`);
    }
    setSeeding(false);
    await load();
  }, [orgId, load]);

  const reportsToLabel = useCallback((p: GovPillarSummary): string => {
    if (!p.reports_to_pillar_id) return 'Founder';
    return pillarNameById.get(p.reports_to_pillar_id) ?? '—';
  }, [pillarNameById]);

  const isEmpty = !loading && pillars.length === 0 && policies.length === 0;

  // Stat counts for the header cards.
  const stats = {
    pillars: pillars.length,
    employees: chartEmployees.filter((e) => e.status !== 'offboarded' && e.status !== 'disabled').length,
    platforms: platforms.length,
    departments: chartDepartments.length,
    channels: channels.length,
    policies: policies.filter((p) => p.is_active).length,
  };

  return (
    <DashboardLayout>
      <div className="px-4 md:px-8 py-6 max-w-7xl mx-auto">
        {/* Hero header with gradient */}
        <div className="relative overflow-hidden rounded-2xl mb-6 p-6 md:p-8"
          style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(37,99,168,0.08) 60%, transparent 100%)', border: '1px solid rgba(16,185,129,0.18)' }}
        >
          <div className="flex items-start justify-between gap-4 flex-wrap relative z-10">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold tracking-widest uppercase mb-3">
                <i className="ri-shield-keyhole-line" /> Access &amp; Communication Governance
              </div>
              <h1 className="text-3xl font-bold text-white tracking-tight">
                {organization?.name ?? 'Your Organization'}
              </h1>
              <p className="text-sm text-gray-400 mt-2 max-w-2xl">
                Live org chart from your employees, ownership of every platform, channels, access register, and the policies that bind them. Edits in <a href="/employees/managers" className="text-emerald-400 hover:underline">/employees/managers</a> flow in automatically.
              </p>
            </div>
            {canWrite && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setEditingPillar(null)}
                  className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold shadow-lg shadow-emerald-500/20 transition"
                >
                  <i className="ri-add-line mr-1" /> New pillar
                </button>
                {isEmpty && (
                  <button
                    onClick={handleSeedDefaults}
                    disabled={seeding}
                    className="px-4 py-2 text-sm rounded-lg border border-dark-600 bg-dark-800/50 text-gray-200 hover:bg-dark-800 disabled:opacity-50 transition"
                    title="Pre-loads a 9-pillar marketing/ops template you can rename or delete."
                  >
                    <i className="ri-magic-line mr-1" />
                    {seeding ? 'Loading…' : 'Starter template'}
                  </button>
                )}
              </div>
            )}
          </div>
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mt-6 relative z-10">
            {[
              { icon: 'ri-team-line',           label: 'Employees',  value: stats.employees,   color: 'emerald' },
              { icon: 'ri-building-2-line',     label: 'Departments', value: stats.departments, color: 'blue' },
              { icon: 'ri-stack-line',          label: 'Pillars',    value: stats.pillars,     color: 'purple' },
              { icon: 'ri-apps-2-line',         label: 'Platforms',  value: stats.platforms,   color: 'amber' },
              { icon: 'ri-chat-3-line',         label: 'Channels',   value: stats.channels,    color: 'cyan' },
              { icon: 'ri-shield-check-line',   label: 'Policies',   value: stats.policies,    color: 'rose' },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-dark-900/60 backdrop-blur border border-dark-700 px-4 py-3 hover:border-dark-600 transition">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  <i className={`${s.icon} text-${s.color}-400`} />
                  {s.label}
                </div>
                <div className="text-2xl font-bold text-white tabular-nums">{s.value}</div>
              </div>
            ))}
          </div>
          {/* Decorative gradient blob */}
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full opacity-20"
            style={{ background: 'radial-gradient(circle, #10b981 0%, transparent 70%)', filter: 'blur(40px)' }}
          />
        </div>

        {/* Tabs — icon + label, modern pill style */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {([
            ['org',        'ri-node-tree',         'Org Chart',        'Visual hierarchy from employees'],
            ['leadership', 'ri-vip-crown-line',    'Leadership',       'Pillar owners & backups'],
            ['platforms',  'ri-apps-2-line',       'Platforms',        'Ownership emails'],
            ['pillars',    'ri-stack-line',        'Pillar Details',   'Per-pillar access model'],
            ['register',   'ri-shield-keyhole-line','Access Register', 'Per-platform individuals'],
            ['policies',   'ri-file-list-3-line',  'Policies',         'P01..P08 rules'],
          ] as const).map(([key, icon, label, hint]) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                title={hint}
                className={`group flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm whitespace-nowrap border transition-all ${
                  active
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-white shadow-sm shadow-emerald-500/10'
                    : 'border-dark-700 bg-dark-900/40 text-gray-400 hover:text-gray-100 hover:border-dark-600'
                }`}
              >
                <i className={`${icon} text-base ${active ? 'text-emerald-400' : 'text-gray-500 group-hover:text-emerald-400'}`} />
                <span className="font-medium">{label}</span>
              </button>
            );
          })}
        </div>

        {loading && <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>}

        {!loading && tab === 'leadership' && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-500">
                Every pillar needs a named Owner and Backup. A blank Owner = unresolved accountability.
              </p>
              {canWrite && (
                <button
                  onClick={() => setEditingPillar(null)}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                >+ Add pillar</button>
              )}
            </div>
            <LeadershipTable
              pillars={pillarSummary}
              reportsToLabel={reportsToLabel}
              onEditPillar={canWrite ? (id) => {
                const p = pillars.find((x) => x.id === id);
                if (p) setEditingPillar(p);
              } : undefined}
            />
          </section>
        )}

        {!loading && tab === 'org' && (
          <section className="space-y-6">
            <div>
              <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
                <h3 className="text-xs uppercase tracking-wider text-gray-500">Reporting Hierarchy</h3>
                <div className="flex items-center gap-3">
                  {canWrite && (
                    <button
                      type="button"
                      disabled={syncingM365}
                      onClick={async () => {
                        if (syncingM365) return;
                        if (!confirm('Push every portal manager assignment to Microsoft 365 now?\n\nThis updates Entra ID immediately. The M365 Admin Center may take 5–30 minutes to reflect changes (cache lag).')) return;
                        setSyncingM365(true); setM365SyncResult(null);
                        try {
                          const { data: { session } } = await supabase.auth.getSession();
                          const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/m365-bulk-sync-managers`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
                            body: '{}',
                          });
                          const j = await r.json().catch(() => ({}));
                          if (!r.ok) { setM365SyncResult(`Error: ${j?.error ?? r.status}`); }
                          else {
                            setM365SyncResult(`Synced — ${j.pushed} pushed, ${j.cleared} cleared, ${j.skipped_no_m365} skip(no M365 link), ${j.skipped_manager_no_m365} skip(manager not linked), ${j.failed} failed`);
                          }
                        } catch (e) { setM365SyncResult(`Error: ${(e as Error).message}`); }
                        finally { setSyncingM365(false); }
                      }}
                      className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white inline-flex items-center gap-1.5"
                      title="Push every portal manager_id to Microsoft 365 in one shot"
                    >
                      <i className={syncingM365 ? 'ri-loader-4-line animate-spin' : 'ri-microsoft-line'} />
                      {syncingM365 ? 'Syncing…' : 'Sync managers to M365'}
                    </button>
                  )}
                  <p className="text-[11px] text-gray-500">
                    Built from <strong>employees → manager_id</strong>. Add/edit at <a href="/employees/managers" className="text-emerald-400 hover:underline">/employees/managers</a>.
                  </p>
                </div>
              </div>
              {m365SyncResult && (
                <div className={`mb-2 rounded-md border px-3 py-2 text-[11px] ${m365SyncResult.startsWith('Error') ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'}`}>
                  {m365SyncResult}
                </div>
              )}
              <OrgChart
                employees={chartEmployees}
                departments={chartDepartments}
                orgName={organization?.name ?? null}
                canEdit={canWrite}
                onEmployeeMoved={load}
              />
            </div>
            {/* Pillar-based view (optional overlay) — useful when org-chart by
                manager hierarchy isn't the same as functional ownership. */}
            {pillarSummary.length > 0 && (
              <details className="rounded-xl border border-dark-700 bg-dark-900/30 p-4">
                <summary className="text-xs uppercase tracking-wider text-gray-500 cursor-pointer">
                  Pillar view (optional · functional ownership)
                </summary>
                <div className="mt-3">
                  <OrgTree
                    founderName={founderName}
                    pillars={pillarSummary}
                    assignmentsByPillar={assignmentsByPillar}
                    userById={userById}
                  />
                </div>
              </details>
            )}
            <div>
              <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Channel Structure</h3>
              <ChannelTable
                channels={channels}
                pillarNameById={pillarNameById}
                memberCountById={channelMemberCount}
              />
            </div>
          </section>
        )}

        {!loading && tab === 'platforms' && (
          <section className="space-y-4">
            <div className="rounded-lg border-l-4 border-emerald-500 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
              <strong>Why this model:</strong> When an employee leaves, their individual access is revoked.
              The ownership email never changes — the business always retains control of every platform.
              Multiple variants of the same platform (e.g. Amazon Seller US/CA/MX/IN) each get their own row, each linked to a different vault credential.
            </div>
            <PlatformManager
              platforms={platforms}
              pillars={pillars}
              accessRows={accessRows}
              users={users}
              canEdit={canWrite}
              onEditPlatform={(id, defaultPillarId) => {
                if (!id) {
                  setEditingPlatform({ platform: null, pillarId: defaultPillarId });
                } else {
                  const pl = platforms.find((p) => p.id === id);
                  if (pl) setEditingPlatform({ platform: pl });
                }
              }}
              onReload={load}
            />
          </section>
        )}

        {!loading && tab === 'pillars' && (
          <section className="space-y-4">
            {pillarSummary.length === 0 ? (
              <div className="rounded-xl border border-dashed border-dark-700 bg-dark-900/40 p-10 text-center text-sm text-gray-500">
                No pillars yet. Seed defaults to load the template.
              </div>
            ) : (
              pillarSummary.map((s) => {
                const pillar = pillars.find((p) => p.id === s.id);
                if (!pillar) return null;
                return (
                  <PillarDetailCard
                    key={pillar.id}
                    pillar={pillar}
                    platforms={platformsByPillar.get(pillar.id) ?? []}
                    assignments={assignmentsByPillar.get(pillar.id) ?? []}
                    userById={userById}
                    channelName={channelByPillar.get(pillar.id)}
                    onEditPillar={canWrite ? () => setEditingPillar(pillar) : undefined}
                    onAssignRoles={canWrite ? () => setAssigningPillar(pillar) : undefined}
                    onAddPlatform={canWrite ? () => setEditingPlatform({ platform: null, pillarId: pillar.id }) : undefined}
                  />
                );
              })
            )}
          </section>
        )}

        {!loading && tab === 'register' && (
          <section>
            <div className="rounded-lg border-l-4 border-blue-500 bg-blue-500/10 px-4 py-3 text-xs text-blue-200 mb-4">
              <strong>Email Convention:</strong> All individual access uses <code className="font-mono">firstname@company.com</code>.
              Department group emails (<code className="font-mono">seo@</code>, <code className="font-mono">retention@</code>) cover the full pillar team.
            </div>
            <AccessRegisterTable
              rows={accessRows}
              platforms={platforms}
              userById={userById}
            />
          </section>
        )}

        {!loading && tab === 'policies' && (
          <section>
            <p className="text-xs text-gray-500 mb-3">Enforced by IT — mandatory.</p>
            <PolicyList
              policies={policies}
              onAddPolicy={canWrite ? () => setEditingPolicy(null) : undefined}
              onEditPolicy={canWrite ? (id) => {
                const p = policies.find((x) => x.id === id);
                if (p) setEditingPolicy(p);
              } : undefined}
            />
          </section>
        )}

        {/* ── Modals ── */}
        {editingPillar !== undefined && (
          <PillarEditModal
            pillar={editingPillar}
            allPillars={pillars}
            onSaved={load}
            onClose={() => setEditingPillar(undefined)}
          />
        )}
        {assigningPillar && (
          <AssignRoleModal
            pillar={assigningPillar}
            users={users}
            existing={assignmentsByPillar.get(assigningPillar.id) ?? []}
            onSaved={load}
            onClose={() => setAssigningPillar(null)}
          />
        )}
        {editingPlatform && (
          <PlatformEditModal
            platform={editingPlatform.platform}
            pillars={pillars}
            defaultPillarId={editingPlatform.pillarId}
            onSaved={load}
            onClose={() => setEditingPlatform(null)}
          />
        )}
        {editingPolicy !== undefined && (
          <PolicyEditModal
            policy={editingPolicy}
            onSaved={load}
            onClose={() => setEditingPolicy(undefined)}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
