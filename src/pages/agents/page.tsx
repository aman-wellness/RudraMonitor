import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAgents, useProductivityPerAgent, type UiAgent } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { Bar, EmptyNote, Panel, Segmented } from '@/pages/dashboard/components/ui';
import { C, formatHm } from '@/pages/dashboard/components/chartKit';
import { confirmDialog, notify } from '@/lib/notify';
import Pagination, { usePagination } from '@/pages/monitoring/components/Pagination';

/* All Agents.

   Nothing here is hardcoded — an earlier version shipped a fixed department
   list (Development / HR / Finance / Design / Marketing) that matched no real
   data and colour-coded only those names.

   Departments come from TWO sources, and both are needed. org_departments is
   what the org has declared; the agent rows supply the headcounts. Deriving the
   list from the agents alone (which this page did until it was reported showing
   one department out of six) hides every department nobody is in yet — and
   since this page's dropdown is how an agent gets assigned, such a department
   could never receive its first member. Colours are hashed from the name, so
   they stay stable across pages without anyone maintaining a map.

   Density and surfaces match the dashboard's design system so the two pages
   read as one product. */

type StatusFilter = 'all' | 'online' | 'idle' | 'offline';
type ViewMode = 'grid' | 'list';
type StatWindow = '24' | '168' | '720';

const WINDOWS: { id: StatWindow; label: string }[] = [
  { id: '24', label: '24H' },
  { id: '168', label: '7D' },
  { id: '720', label: '30D' },
];

const STATUSES: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'idle', label: 'Idle' },
  { id: 'offline', label: 'Offline' },
];

const UNASSIGNED = 'Unassigned';

/** Tallest the department list inside the assign popover may get, in px.
 *  Roughly nine rows at 28px; beyond that it scrolls. */
const DEPT_MENU_MAX_H = 252;

/** Stable colour per label: same department, same colour, everywhere, without
 *  anyone maintaining a name→colour map. */
const catColor = (label: string) => {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return `var(--d-cat-${(h % 8) + 1})`;
};

const OS_ICON = (os: string) => {
  if (os.includes('Windows')) return 'ri-windows-fill';
  if (os.includes('macOS') || os.includes('Darwin')) return 'ri-apple-fill';
  if (os.includes('Unknown')) return 'ri-question-line';
  return 'ri-ubuntu-fill';
};

const relative = (iso: string) => {
  if (!iso || iso === '-') return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const STATUS_TONE: Record<string, string> = {
  online: 't-success',
  idle: 't-warning',
  offline: 't3',
};

/** Agent plus the stats merged in from the aggregation RPC. */
type Row = UiAgent & {
  /** null = no activity matched a productivity rule, which is not the same as 0%. */
  score: number | null;
  activeSeconds: number;
  idleSeconds: number;
};

export default function AgentsPage() {
  const navigate = useNavigate();
  const { organization } = useAuth();
  const {
    agents: rawAgents,
    loading,
    updateDepartment,
    deleteAgent,
    refresh: refreshAgents,
  } = useAgents();

  const [win, setWin] = useState<StatWindow>('24');
  // useAgents hardcodes productivity/active/idle to zero (it doesn't join
  // activity_logs), so the real numbers are merged in from the RPC.
  const { byAgent } = useProductivityPerAgent(Number(win));

  const agents: Row[] = useMemo(
    () =>
      rawAgents.map((a) => {
        const p = byAgent[a.id];
        const matched = p ? p.weighted_seconds + p.unproductive_seconds : 0;
        return {
          ...a,
          score: matched > 0 ? Math.round((p!.weighted_seconds / matched) * 100) : null,
          activeSeconds: p?.active_seconds ?? 0,
          idleSeconds: p?.idle_seconds ?? 0,
        };
      }),
    [rawAgents, byAgent],
  );

  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  // Screen coords of the trigger. The table view wraps rows in an
  // overflow-x-auto container, which clips absolutely-positioned children —
  // so the popover is positioned against the viewport instead.
  const [deptAnchor, setDeptAnchor] = useState<{ left: number; top: number } | null>(null);
  const [newDept, setNewDept] = useState('');

  const bulkRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the open popovers on an outside click, on Escape, or on scroll —
  // a viewport-anchored menu would otherwise detach from its trigger.
  useEffect(() => {
    if (!bulkOpen && !editingDeptId) return;
    const dismiss = () => {
      setBulkOpen(false);
      setEditingDeptId(null);
      setDeptAnchor(null);
      setNewDept('');
    };
    const onDown = (e: MouseEvent) => {
      if (bulkRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.('.menu')) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [bulkOpen, editingDeptId]);

  /* The org's declared departments, which are NOT derivable from the agents.
     A department nobody is in yet has no agent row to be inferred from, so
     building the list purely from `agents` hid every empty department — and
     since this dropdown is how an agent gets assigned, an empty department
     could never receive its first member. A catch-22 that got worse the more
     departments the org created.

     Fetched once for the page rather than per dropdown: the list is small,
     several surfaces here need it (the badge popover, the filter row, the bulk
     bar), and re-fetching per popover made the options appear a beat late. */
  const [orgDepts, setOrgDepts] = useState<string[]>([]);
  const [deptRefreshKey, setDeptRefreshKey] = useState(0);
  useEffect(() => {
    if (!organization) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('org_departments')
        .select('name')
        .eq('org_id', organization.id)
        .order('name');
      if (!alive) return;
      if (error) { console.error('org_departments', error.message); return; }
      setOrgDepts((data ?? []).map((d) => (d as { name: string }).name).filter(Boolean));
    })();
    return () => { alive = false; };
    // refreshKey so a department created inline below shows up without a reload.
  }, [organization, deptRefreshKey]);

  /** Every department the org has, with live headcounts. */
  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    // Seed with the declared list at zero, so an empty department is offered
    // for assignment and reports an honest count rather than being absent.
    for (const name of orgDepts) counts.set(name, 0);
    for (const a of agents) counts.set(a.department, (counts.get(a.department) ?? 0) + 1);
    // Unassigned is a UI placeholder for a NULL department, not a row in
    // org_departments, so it only belongs here when an agent is actually in it.
    if (counts.get(UNASSIGNED) === 0) counts.delete(UNASSIGNED);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      // Unassigned last; otherwise biggest first, then alphabetical.
      .sort((a, b) =>
        a.name === UNASSIGNED
          ? 1
          : b.name === UNASSIGNED
            ? -1
            : b.count - a.count || a.name.localeCompare(b.name),
      );
  }, [agents, orgDepts]);

  const counts = useMemo(
    () => ({
      all: agents.length,
      online: agents.filter((a) => a.status === 'online').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      offline: agents.filter((a) => a.status === 'offline').length,
      locked: agents.filter((a) => a.seatLocked).length,
    }),
    [agents],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (deptFilter !== 'all' && a.department !== deptFilter) return false;
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.machine.toLowerCase().includes(q) ||
        a.department.toLowerCase().includes(q) ||
        a.ipAddress.toLowerCase().includes(q) ||
        a.os.toLowerCase().includes(q)
      );
    });
  }, [agents, search, deptFilter, statusFilter]);

  // Paginates the RENDER only. Selection deliberately still spans the whole
  // filtered set: the header checkbox means "every agent this filter matches",
  // which is what makes a bulk action on a filter useful. Narrowing it to the
  // current page would quietly change what a bulk action does.
  const {
    visible: pageRows, page, pageCount, setPage, from, to, total,
  } = usePagination(filtered, 24);

  // Selection is cleared of anything the current filter hides, so a bulk action
  // can never touch a row the user can't see.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((a) => a.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const allVisibleSelected = filtered.length > 0 && selected.size === filtered.length;

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((a) => a.id)));

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      body: 'This frees the licence seat. Historical activity, screenshots and alerts are kept.',
      confirmLabel: 'Remove agent',
      tone: 'danger',
    });
    if (!ok) return;
    setRemoving(id);
    try {
      await deleteAgent(id);
      notify.success(`${name} removed`, { description: 'One licence seat is now free.' });
    } catch (err) {
      notify.fail('Could not remove agent', err);
    } finally {
      setRemoving(null);
    }
  };

  const handleBulkCapture = async (
    column: 'screenshots_enabled' | 'videos_enabled',
    value: boolean,
  ) => {
    if (selected.size === 0) return;
    const n = selected.size;
    const what = column === 'screenshots_enabled' ? 'Screenshots' : 'Videos';
    setBulkBusy(true);
    setBulkOpen(false);
    try {
      const { error } = await supabase
        .from('agents')
        .update({ [column]: value })
        .in('id', [...selected]);
      if (error) throw error;
      await refreshAgents();
      notify.success(`${what} ${value ? 'enabled' : 'disabled'}`, {
        description: `Applied to ${n} agent${n === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      notify.fail(`Could not ${value ? 'enable' : 'disable'} ${what.toLowerCase()}`, err);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkRemove = async () => {
    const n = selected.size;
    if (n === 0) return;
    const ok = await confirmDialog({
      title: `Remove ${n} agent${n === 1 ? '' : 's'}?`,
      body: `This frees ${n} licence seat${n === 1 ? '' : 's'}. Historical activity, screenshots and alerts are kept.`,
      confirmLabel: `Remove ${n} agent${n === 1 ? '' : 's'}`,
      tone: 'danger',
    });
    if (!ok) return;
    setBulkBusy(true);
    setBulkOpen(false);
    try {
      const { error } = await supabase.from('agents').delete().in('id', [...selected]);
      if (error) throw error;
      setSelected(new Set());
      await refreshAgents();
      notify.success(`${n} agent${n === 1 ? '' : 's'} removed`, {
        description: `${n} licence seat${n === 1 ? '' : 's'} freed.`,
      });
    } catch (err) {
      notify.fail('Could not remove agents', err);
    } finally {
      setBulkBusy(false);
    }
  };

  const assignDept = async (agentId: string, dept: string) => {
    const name = dept.trim();
    if (!name) return;
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.department === name) {
      setEditingDeptId(null);
      setDeptAnchor(null);
      return;
    }
    setEditingDeptId(null);
    setDeptAnchor(null);
    setNewDept('');
    await updateDepartment(agentId, name);
    // updateDepartment also upserts into org_departments (see ensureDepartment
    // in dataHooks), so re-read the list: a name typed into "New department"
    // would otherwise be missing from every other agent's dropdown until a
    // page reload.
    setDeptRefreshKey((k) => k + 1);
    notify.success(`Moved to ${name}`, { description: agent?.name });
  };

  const openDeptMenu = (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    if (editingDeptId === agentId) {
      setEditingDeptId(null);
      setDeptAnchor(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Estimated menu height; flip above the trigger when it wouldn't fit below.
    // Capped to match the scroll container in deptMenu — without the cap this
    // over-estimates for a long list and flips a menu that would have fit.
    const height = Math.min(departments.length * 28, DEPT_MENU_MAX_H) + 62;
    const below = window.innerHeight - r.bottom;
    setDeptAnchor({
      left: Math.min(r.left, window.innerWidth - 196),
      top: below < height ? Math.max(8, r.top - height - 4) : r.bottom + 4,
    });
    setEditingDeptId(agentId);
    setNewDept('');
  };

  const initials = (name: string) =>
    name
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();

  const scoreColor = (score: number) =>
    score >= 80 ? C.success : score >= 55 ? C.accent : C.warning;

  /* ---- department badge + its assign popover ---- */
  const DeptBadge = ({ agent }: { agent: Row }) => (
    <button
      onClick={(e) => openDeptMenu(e, agent.id)}
      className="chip chip-quiet text-[9.5px]"
      title="Change department"
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: catColor(agent.department) }}
      />
      {agent.department}
      <i className="ri-arrow-down-s-line" />
    </button>
  );

  // Rendered once at the page root, not inside the row, so the table's
  // horizontal scroll container can't clip it.
  const deptMenu = (() => {
    const agent = filtered.find((a) => a.id === editingDeptId);
    if (!agent || !deptAnchor) return null;
    return (
      <div
        className="menu"
        style={{ position: 'fixed', left: deptAnchor.left, top: deptAnchor.top, right: 'auto', minWidth: 188 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Scrolls rather than growing without limit. Now that empty
            departments are listed too, an org with a long list would otherwise
            render a menu taller than the viewport, and the flip-above logic
            would only move where it gets cut off. DEPT_MENU_MAX_H keeps the
            "New department" field below permanently reachable. */}
        <div style={{ maxHeight: DEPT_MENU_MAX_H, overflowY: 'auto' }}>
          {departments.map((d) => (
            <button key={d.name} onClick={() => void assignDept(agent.id, d.name)}>
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: catColor(d.name) }}
              />
              <span className="flex-1 text-left truncate">{d.name}</span>
              {/* Headcount, so an admin can see which departments are empty
                  without cross-referencing the filter row. */}
              {d.count > 0 && <span className="text-[10px] t3 tnum">{d.count}</span>}
              {d.name === agent.department && <i className="ri-check-line text-[12px]" />}
            </button>
          ))}
        </div>
        {/* Without this, deriving the list from existing rows would make a new
            department impossible to create. */}
        <div className="p-1 hair-t mt-1">
          <span className="field">
            <i className="ri-add-line text-[12px] t3" />
            <input
              type="text"
              autoFocus
              value={newDept}
              onChange={(e) => setNewDept(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void assignDept(agent.id, newDept);
              }}
              placeholder="New department"
              className="w-full text-[11px]"
            />
          </span>
        </div>
      </div>
    );
  })();

  const StatusPill = ({ agent }: { agent: Row }) =>
    agent.seatLocked ? (
      <span
        className="chip chip-danger text-[9.5px]"
        title="Beyond your licensed seat count — this agent has stopped reporting. Upgrade, or remove another agent to free a seat."
      >
        <i className="ri-lock-2-line" />
        Locked
      </span>
    ) : (
      <span className={`inline-flex items-center gap-1.5 text-[10.5px] ${STATUS_TONE[agent.status]}`}>
        <span
          className={`live-dot ${agent.status === 'online' ? '' : 'is-off'}`}
          style={agent.status === 'idle' ? { background: 'var(--d-warning)' } : undefined}
        />
        {agent.status === 'online' ? 'Online' : agent.status === 'idle' ? 'Idle' : 'Offline'}
      </span>
    );

  const winLabel = WINDOWS.find((x) => x.id === win)?.label ?? '';

  return (
    <DashboardLayout>
      <div className="dash">
        {deptMenu}
        {/* ------------------------------------------------------- header ---- */}
        <div className="flex items-center gap-1.5 text-[10.5px] t3 mb-3">
          <Link to="/dashboard" className="hover:underline flex items-center gap-1">
            <i className="ri-dashboard-line text-[12px]" />
            Dashboard
          </Link>
          <i className="ri-arrow-right-s-line" />
          <span className="t1 font-medium">Agents</span>
        </div>

        {counts.locked > 0 && (
          <div className="banner mb-4">
            <div className="min-w-0">
              <p className="text-[11.5px] t-danger font-medium">
                <i className="ri-lock-2-line mr-1" />
                {counts.locked} agent{counts.locked === 1 ? '' : 's'} locked — over your licensed
                seat count.
              </p>
              <p className="text-[10.5px] t3 mt-0.5">
                Locked agents stop reporting. Upgrade your plan to re-activate them, or remove
                others to free seats.
              </p>
            </div>
            <Link to="/subscription" className="chip chip-danger text-[10px] flex-shrink-0">
              Upgrade plan
              <i className="ri-arrow-right-line" />
            </Link>
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div className="min-w-0">
            <h1 className="num" style={{ fontSize: 18 }}>
              All agents
            </h1>
            <p className="text-[11.5px] t3 mt-1">
              {counts.all === 0 ? (
                'No agents enrolled yet'
              ) : (
                <>
                  <span className="t-success">{counts.online} online</span>
                  {counts.idle > 0 && <> · {counts.idle} idle</>}
                  {counts.offline > 0 && <> · {counts.offline} offline</>}
                  <> · {counts.all} enrolled</>
                </>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Segmented value={win} options={WINDOWS} onChange={setWin} />
            <Segmented
              value={viewMode}
              options={[
                { id: 'grid', label: 'Cards' },
                { id: 'list', label: 'Table' },
              ]}
              onChange={setViewMode}
            />
            <button onClick={() => navigate('/setup')} className="chip chip-accent text-[11px]">
              <i className="ri-add-line" />
              Add agent
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ filters ----
            Two rows: the department list grows with the org and would otherwise
            squeeze the search box and the status group off the line. */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2.5">
          <span className="field flex-1" style={{ minWidth: 240, maxWidth: 380 }}>
            <i className="ri-search-line text-[12px] t3" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, machine, department, IP…"
              className="w-full text-[11.5px]"
            />
            {search && (
              <button onClick={() => setSearch('')} className="t3 hover:opacity-70" aria-label="Clear search">
                <i className="ri-close-line text-[12px]" />
              </button>
            )}
          </span>

          <div className="seg flex-shrink-0">
            {STATUSES.map((s) => (
              <button
                key={s.id}
                onClick={() => setStatusFilter(s.id)}
                className={`seg-btn ${statusFilter === s.id ? 'is-on' : ''}`}
              >
                {s.label}
                <span className="t3"> {counts[s.id]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Filters, with live counts.

            Only departments that actually have someone in them. The assign
            dropdown deliberately lists empty ones — that is how they get their
            first member — but a filter chip for a department with nobody in it
            can only ever produce an empty table, so it is width spent on a
            dead end. The one exception is a filter already active: dropping the
            chip mid-filter would strand the user on a selection they can see no
            way back out of. */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <div className="seg overflow-x-auto max-w-full">
            <button
              onClick={() => setDeptFilter('all')}
              className={`seg-btn ${deptFilter === 'all' ? 'is-on' : ''}`}
            >
              All<span className="t3"> {counts.all}</span>
            </button>
            {departments.filter((d) => d.count > 0 || deptFilter === d.name).map((d) => (
              <button
                key={d.name}
                onClick={() => setDeptFilter(d.name)}
                className={`seg-btn ${deptFilter === d.name ? 'is-on' : ''}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: catColor(d.name) }}
                  />
                  {d.name}
                  <span className="t3">{d.count}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------- selection ---- */}
        {selected.size > 0 && (
          <div className="selbar mb-4" ref={bulkRef}>
            <span className="text-[11px] t-accent font-medium">
              {selected.size} of {filtered.length} selected
            </span>
            <div className="flex items-center gap-1.5 relative">
              <button
                onClick={() => setBulkOpen((v) => !v)}
                disabled={bulkBusy}
                className="chip chip-quiet text-[10.5px]"
              >
                {bulkBusy && <i className="ri-loader-4-line animate-spin" />}
                Actions
                <i className="ri-arrow-down-s-line" />
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[10.5px] t3 hover:opacity-70 px-1"
              >
                Clear
              </button>

              {bulkOpen && (
                <div className="menu" style={{ top: 28, minWidth: 196 }}>
                  <button onClick={() => handleBulkCapture('screenshots_enabled', true)} disabled={bulkBusy}>
                    <i className="ri-camera-line" /> Enable screenshots
                  </button>
                  <button onClick={() => handleBulkCapture('screenshots_enabled', false)} disabled={bulkBusy}>
                    <i className="ri-camera-off-line" /> Disable screenshots
                  </button>
                  <button onClick={() => handleBulkCapture('videos_enabled', true)} disabled={bulkBusy}>
                    <i className="ri-video-line" /> Enable videos
                  </button>
                  <button onClick={() => handleBulkCapture('videos_enabled', false)} disabled={bulkBusy}>
                    <i className="ri-video-off-line" /> Disable videos
                  </button>
                  <div className="hair-t my-1" />
                  <button onClick={handleBulkRemove} disabled={bulkBusy} className="s-row-danger">
                    <i className={bulkBusy ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} />
                    Remove {selected.size} agent{selected.size === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* -------------------------------------------------------- empty ---- */}
        {!loading && filtered.length === 0 && (
          <Panel title="Agents">
            <EmptyNote
              title={counts.all === 0 ? 'No agents enrolled yet' : 'No agents match your filters'}
              hint={
                counts.all === 0
                  ? 'Install the desktop agent on employee machines using your licence key.'
                  : 'Try clearing the search or switching the department and status filters.'
              }
            />
            {counts.all === 0 && (
              <div className="flex justify-center pb-1">
                <button onClick={() => navigate('/setup')} className="chip chip-accent text-[11px]">
                  <i className="ri-add-line" />
                  Add your first agent
                </button>
              </div>
            )}
          </Panel>
        )}
        {loading && agents.length === 0 && (
          <Panel title="Agents">
            <EmptyNote title="Loading agents…" />
          </Panel>
        )}

        {/* --------------------------------------------------- card view ---- */}
        {viewMode === 'grid' && filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3.5">
            {pageRows.map((agent, i) => (
              <section
                key={agent.id}
                className={`panel rise card-link p-4 ${selected.has(agent.id) ? 'is-sel' : ''}`}
                style={{ ['--i' as string]: Math.min(i, 8) }}
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                <div className="flex items-start gap-2.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelect(agent.id);
                    }}
                    className={`cbx mt-1 ${selected.has(agent.id) ? 'is-on' : ''}`}
                    aria-label={`Select ${agent.name}`}
                  >
                    <i className="ri-check-line" />
                  </button>

                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[11px] font-semibold"
                    style={{
                      color: catColor(agent.department),
                      background: 'var(--d-sunken)',
                      border: '1px solid var(--d-line-soft)',
                    }}
                  >
                    {initials(agent.name)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12.5px] t1 font-medium truncate">{agent.name}</p>
                        <p className="text-[10.5px] t3 truncate">{agent.machine}</p>
                      </div>
                      <StatusPill agent={agent} />
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap mt-3.5">
                  <DeptBadge agent={agent} />
                  <span className="chip chip-quiet text-[9.5px]">
                    <i className={`${OS_ICON(agent.os)} text-[11px]`} />
                    {agent.os}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-3">
                  <span className="tile">
                    <span className="num block" style={{ fontSize: 13 }}>
                      {agent.score === null ? '—' : `${agent.score}%`}
                    </span>
                    <span className="block text-[9px] t3 mt-1">Productive</span>
                  </span>
                  <span className="tile">
                    <span className="num block" style={{ fontSize: 13 }}>
                      {formatHm(agent.activeSeconds)}
                    </span>
                    <span className="block text-[9px] t3 mt-1">Active</span>
                  </span>
                  <span className="tile">
                    <span className="num block" style={{ fontSize: 13 }}>
                      {formatHm(agent.idleSeconds)}
                    </span>
                    <span className="block text-[9px] t3 mt-1">Idle</span>
                  </span>
                </div>

                {agent.score !== null && (
                  <div className="mt-2.5">
                    <Bar pct={agent.score} color={scoreColor(agent.score)} height={3} />
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 mt-3.5 pt-2.5 hair-t">
                  <span className="text-[10px] t3 truncate flex items-center gap-1.5">
                    <i className="ri-global-line text-[11px]" />
                    {agent.ipAddress}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] t3" title={agent.lastActive}>
                      <i className="ri-time-line text-[11px] mr-1" />
                      {relative(agent.lastActive)}
                    </span>
                    <button
                      onClick={(e) => handleDelete(e, agent.id, agent.name)}
                      disabled={removing === agent.id}
                      title="Remove agent (frees licence)"
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                    >
                      <i
                        className={`${removing === agent.id ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} text-[12px]`}
                      />
                    </button>
                  </span>
                </div>
              </section>
            ))}
          </div>
        )}

        {/* --------------------------------------------------- table view ---- */}
        {viewMode === 'list' && filtered.length > 0 && (
          <Panel title="Agents" hint={`Stats over ${winLabel}`} flush>
            <div className="overflow-x-auto">
              <table className="d-table min-w-[880px]">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <button
                        onClick={selectAll}
                        className={`cbx ${allVisibleSelected ? 'is-on' : ''}`}
                        aria-label="Select all visible agents"
                      >
                        <i className="ri-check-line" />
                      </button>
                    </th>
                    <th>Agent</th>
                    <th>Machine</th>
                    <th>Status</th>
                    <th>Productive</th>
                    <th>Active</th>
                    <th>Department</th>
                    <th>Last seen</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((agent) => (
                    <tr key={agent.id} onClick={() => navigate(`/agents/${agent.id}`)}>
                      <td onClick={(e) => { e.stopPropagation(); toggleSelect(agent.id); }}>
                        <span
                          className={`cbx ${selected.has(agent.id) ? 'is-on' : ''}`}
                          role="checkbox"
                          aria-checked={selected.has(agent.id)}
                        >
                          <i className="ri-check-line" />
                        </span>
                      </td>

                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span
                            className="avatar"
                            style={{ color: catColor(agent.department) }}
                          >
                            {initials(agent.name)}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[12px] t1 font-medium leading-tight">
                              {agent.name}
                            </span>
                            <span className="block text-[10px] t3 mt-0.5">{agent.ipAddress}</span>
                          </span>
                        </div>
                      </td>

                      <td className="whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <i className={`${OS_ICON(agent.os)} text-[13px] t3`} />
                          <span className="min-w-0">
                            <span className="block text-[11.5px] t2 leading-tight">
                              {agent.machine}
                            </span>
                            <span className="block text-[10px] t3 mt-0.5">{agent.os}</span>
                          </span>
                        </span>
                      </td>

                      <td className="whitespace-nowrap">
                        <StatusPill agent={agent} />
                      </td>

                      <td style={{ width: 116 }}>
                        {agent.score === null ? (
                          <span className="text-[11px] t3">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="block w-12">
                              <Bar pct={agent.score} height={4} color={scoreColor(agent.score)} />
                            </span>
                            <span className="text-[11px] t2 tnum">{agent.score}%</span>
                          </div>
                        )}
                      </td>

                      <td className="whitespace-nowrap">
                        <span className="block text-[11.5px] t2 tnum leading-tight">
                          {formatHm(agent.activeSeconds)}
                        </span>
                        <span className="block text-[10px] t3 mt-0.5">
                          idle {formatHm(agent.idleSeconds)}
                        </span>
                      </td>

                      <td onClick={(e) => e.stopPropagation()}>
                        <DeptBadge agent={agent} />
                      </td>

                      <td className="whitespace-nowrap">
                        <span className="text-[11px] t3" title={agent.lastActive}>
                          {relative(agent.lastActive)}
                        </span>
                      </td>

                      <td className="text-right">
                        <button
                          onClick={(e) => handleDelete(e, agent.id, agent.name)}
                          disabled={removing === agent.id}
                          title="Remove agent (frees licence)"
                          className="icon-btn"
                        >
                          <i
                            className={`${removing === agent.id ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} text-[12px]`}
                          />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-3 py-2 hair-t">
              <Pagination
                page={page} pageCount={pageCount} from={from} to={to} total={total}
                onPage={setPage} unit={`of ${counts.all} agents`}
              />
            </div>
          </Panel>
        )}

        {viewMode === 'grid' && filtered.length > 0 && (
          <div className="mt-3.5 space-y-1.5">
            <Pagination
              page={page} pageCount={pageCount} from={from} to={to} total={total}
              onPage={setPage} unit={`of ${counts.all} agents`}
            />
            <p className="text-[10px] t3">
              productivity, active and idle over {winLabel}
            </p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
