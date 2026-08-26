import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { confirmDialog, notify } from '@/lib/notify';

/* Identity strip for one agent: who, which machine, what state, and the two
   actions that belong at this level.

   Two things that were broken here:
     • "All Agents" navigated to /dashboard, not /agents.
     • "Remove" had no onClick at all — a destructive-looking button that did
       nothing when pressed.
   Both fixed; Remove now confirms, reports, and returns to the list. */

interface Props {
  agentId: string;
  orgId: string | null;
  name: string;
  machine: string;
  status: string;
  version: string;
  ipAddress: string;
  os?: string;
  department?: string;
  onDepartmentChange?: (next: string | null) => void;
  /** Right-hand slot — the date-range picker sits here so the two share a row. */
  children?: React.ReactNode;
}

type DeptRow = { id: string; name: string; color: string | null };

// org_departments stores a colour NAME; map it onto the categorical tokens so
// department colours match the rest of the app in both themes.
const DEPT_TOKEN: Record<string, string> = {
  emerald: 'var(--d-cat-7)',
  teal: 'var(--d-cat-2)',
  cyan: 'var(--d-cat-5)',
  blue: 'var(--d-cat-5)',
  violet: 'var(--d-cat-6)',
  pink: 'var(--d-cat-4)',
  rose: 'var(--d-cat-4)',
  amber: 'var(--d-cat-3)',
};

/** Stable fallback colour when a department has none set. */
const hashColor = (label: string) => {
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

export default function AgentHeader({
  agentId,
  orgId,
  name,
  machine,
  status,
  version,
  ipAddress,
  os,
  department,
  onDepartmentChange,
  children,
}: Props) {
  const navigate = useNavigate();
  const [dept, setDept] = useState<string | null>(
    department && department !== 'Unassigned' ? department : null,
  );
  const [editing, setEditing] = useState(false);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Rename UI state — inline editable display name. `machine` (system
  // hostname) always renders in the meta row below so the admin can
  // still tie the display name back to the real box even after renaming.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [savingName, setSavingName] = useState(false);
  useEffect(() => { setNameDraft(name); }, [name]);
  const saveRename = async () => {
    const next = nameDraft.trim();
    if (!next || next === name) { setRenaming(false); return; }
    setSavingName(true);
    const { error } = await supabase.from('agents').update({ agent_name: next }).eq('id', agentId);
    setSavingName(false);
    if (error) {
      notify.fail('Rename failed', error.message);
      return;
    }
    notify.success(`Renamed to "${next}"`);
    setRenaming(false);
    // No need to setName() locally — the parent re-fetches on realtime UPDATE
    // for the row (see useAgentDetail); the new value flows back in via props.
  };

  useEffect(() => {
    setDept(department && department !== 'Unassigned' ? department : null);
  }, [department]);

  // Fetch the org's department list when the dropdown opens — cheap, and always
  // current.
  useEffect(() => {
    if (!editing || !orgId) return;
    (async () => {
      const { data } = await supabase
        .from('org_departments')
        .select('id, name, color')
        .eq('org_id', orgId)
        .order('name');
      setDepartments((data as DeptRow[]) ?? []);
    })();
  }, [editing, orgId]);

  useEffect(() => {
    if (!editing) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setEditing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [editing]);

  const initials = name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const colorFor = (row: DeptRow | null, label: string | null) => {
    if (row?.color && DEPT_TOKEN[row.color]) return DEPT_TOKEN[row.color];
    return label ? hashColor(label) : 'var(--d-neutral)';
  };

  const currentRow = departments.find((d) => d.name === dept) ?? null;

  const assign = async (next: string | null) => {
    setSaving(true);
    const { error } = await supabase.from('agents').update({ department: next }).eq('id', agentId);
    setSaving(false);
    setEditing(false);
    if (error) {
      notify.fail('Could not change department', error);
      return;
    }
    setDept(next);
    notify.success(next ? `Moved to ${next}` : 'Department cleared', { description: name });
    onDepartmentChange?.(next);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      body: 'This frees the licence seat. Historical activity, screenshots and alerts are kept.',
      confirmLabel: 'Remove agent',
      tone: 'danger',
    });
    if (!ok) return;
    setRemoving(true);
    const { error } = await supabase.from('agents').delete().eq('id', agentId);
    setRemoving(false);
    if (error) {
      notify.fail('Could not remove agent', error);
      return;
    }
    notify.success(`${name} removed`, { description: 'One licence seat is now free.' });
    navigate('/agents');
  };

  const statusTone =
    status === 'online' ? 't-success' : status === 'idle' ? 't-warning' : 't3';
  const statusLabel = status === 'online' ? 'Online' : status === 'idle' ? 'Idle' : 'Offline';

  // Skip anything the agent hasn't reported — an empty "</> —" chip is noise.
  // The hostname chip has an explicit title so admins can tell which chip is
  // the real machine name even after they've renamed the display name.
  const meta = [
    { icon: 'ri-computer-line', value: machine, title: `Hostname: ${machine}` },
    { icon: OS_ICON(os ?? ''), value: os ?? '', title: `OS: ${os ?? ''}` },
    { icon: 'ri-global-line', value: ipAddress, title: `IP: ${ipAddress}` },
    { icon: 'ri-code-s-slash-line', value: version, title: `Agent version: ${version}` },
  ].filter((m) => m.value && m.value !== '—' && m.value !== 'Unknown');

  return (
    <div className="panel rise p-3.5" style={{ ['--i' as string]: 0 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-[13px] font-semibold"
            style={{
              color: colorFor(currentRow, dept),
              background: 'var(--d-sunken)',
              border: '1px solid var(--d-line-soft)',
            }}
          >
            {initials}
          </span>

          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              {renaming ? (
                <span className="inline-flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename();
                      else if (e.key === 'Escape') { setNameDraft(name); setRenaming(false); }
                    }}
                    disabled={savingName}
                    maxLength={80}
                    className="num rounded-md px-2 py-0.5 outline-none"
                    style={{
                      fontSize: 17,
                      background: 'var(--d-sunken)',
                      border: '1px solid var(--d-line)',
                      color: 'var(--d-text)',
                      minWidth: 140,
                    }}
                  />
                  <button
                    onClick={() => void saveRename()}
                    disabled={savingName || !nameDraft.trim()}
                    className="chip chip-accent text-[10px]"
                    title="Save name"
                  >
                    <i className={savingName ? 'ri-loader-4-line animate-spin' : 'ri-check-line'} />
                    {savingName ? 'Saving' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setNameDraft(name); setRenaming(false); }}
                    disabled={savingName}
                    className="chip chip-quiet text-[10px]"
                    title="Cancel"
                  >
                    <i className="ri-close-line" />
                  </button>
                </span>
              ) : (
                <>
                  <h1 className="num" style={{ fontSize: 17 }}>
                    {name}
                  </h1>
                  <button
                    onClick={() => setRenaming(true)}
                    className="chip chip-quiet text-[10px]"
                    title="Rename this agent (system hostname is shown below)"
                  >
                    <i className="ri-edit-line" /> Rename
                  </button>
                </>
              )}
              <span className={`inline-flex items-center gap-1.5 text-[11px] ${statusTone}`}>
                <span
                  className={`live-dot ${status === 'online' ? '' : 'is-off'}`}
                  style={status === 'idle' ? { background: 'var(--d-warning)' } : undefined}
                />
                {statusLabel}
              </span>

              <span className="relative inline-flex" ref={wrapRef}>
                <button
                  onClick={() => setEditing(!editing)}
                  disabled={saving}
                  className="chip chip-quiet text-[10px]"
                  title="Change department"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: colorFor(currentRow, dept) }}
                  />
                  {dept ?? 'Unassigned'}
                  <i className={saving ? 'ri-loader-4-line animate-spin' : 'ri-arrow-down-s-line'} />
                </button>

                {editing && (
                  <div className="menu" style={{ left: 0, right: 'auto', top: 26, minWidth: 184 }}>
                    <button onClick={() => void assign(null)}>
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--d-neutral)' }}
                      />
                      <span className="flex-1 text-left">Unassigned</span>
                      {dept === null && <i className="ri-check-line text-[12px]" />}
                    </button>
                    {departments.map((d) => (
                      <button key={d.id} onClick={() => void assign(d.name)}>
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: colorFor(d, d.name) }}
                        />
                        <span className="flex-1 text-left truncate">{d.name}</span>
                        {d.name === dept && <i className="ri-check-line text-[12px]" />}
                      </button>
                    ))}
                    <div className="hair-t mt-1 pt-1">
                      <button
                        onClick={() => {
                          setEditing(false);
                          navigate('/admin-portal?tab=departments');
                        }}
                      >
                        <i className="ri-settings-3-line" />
                        <span className="flex-1 text-left">Manage departments</span>
                      </button>
                    </div>
                  </div>
                )}
              </span>
            </div>

            <div className="flex items-center gap-3 flex-wrap mt-1.5">
              {meta.map((m) => (
                <span
                  key={m.value}
                  title={m.title}
                  className="flex items-center gap-1.5 text-[11px] t3"
                >
                  <i className={`${m.icon} text-[12px]`} />
                  {m.value}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {children}
          <button onClick={() => navigate('/agents')} className="chip chip-quiet text-[10.5px]">
            <i className="ri-arrow-left-line" />
            All agents
          </button>
          <button
            onClick={() => void remove()}
            disabled={removing}
            className="chip chip-danger text-[10.5px]"
          >
            <i className={removing ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} />
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
