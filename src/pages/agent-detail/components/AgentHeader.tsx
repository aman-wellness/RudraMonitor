import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Props {
  agentId: string;
  orgId: string | null;
  name: string;
  machine: string;
  status: string;
  version: string;
  ipAddress: string;
  department?: string;
  onDepartmentChange?: (next: string | null) => void;
}

type DeptRow = { id: string; name: string; color: string | null };

const COLOR_MAP: Record<string, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  cyan:    'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30',
  violet:  'bg-violet-500/15 text-violet-300 border border-violet-500/30',
  amber:   'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  rose:    'bg-rose-500/15 text-rose-300 border border-rose-500/30',
  blue:    'bg-blue-500/15 text-blue-300 border border-blue-500/30',
  pink:    'bg-pink-500/15 text-pink-300 border border-pink-500/30',
  teal:    'bg-teal-500/15 text-teal-300 border border-teal-500/30',
};

const COLOR_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500', cyan: 'bg-cyan-500', violet: 'bg-violet-500',
  amber: 'bg-amber-500', rose: 'bg-rose-500', blue: 'bg-blue-500',
  pink: 'bg-pink-500', teal: 'bg-teal-500',
};

export default function AgentHeader({
  agentId, orgId, name, machine, status, version, ipAddress,
  department, onDepartmentChange,
}: Props) {
  const navigate = useNavigate();
  const [dept, setDept] = useState<string | null>(department && department !== 'Unassigned' ? department : null);
  const [editing, setEditing] = useState(false);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setDept(department && department !== 'Unassigned' ? department : null); }, [department]);

  // Fetch the org's department list whenever the dropdown opens (cheap; up-to-date).
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

  // Click outside closes the dropdown
  useEffect(() => {
    if (!editing) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setEditing(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [editing]);

  const getInitial = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const statusColor =
    status === 'online' ? 'bg-emerald-500/20 text-emerald-300'
    : status === 'idle' ? 'bg-amber-500/20 text-amber-300'
    : 'bg-red-500/20 text-red-300';

  const colorOf = (d: DeptRow | null) => {
    if (!d || !d.color) return 'bg-dark-700 text-gray-200 border border-dark-600';
    return COLOR_MAP[d.color] ?? 'bg-dark-700 text-gray-200 border border-dark-600';
  };

  const currentDeptRow = departments.find((d) => d.name === dept) ?? null;
  const pillClass = dept ? colorOf(currentDeptRow ?? { id: '', name: dept, color: null }) : 'bg-dark-700 text-gray-300 border border-dark-600';

  const assign = async (next: string | null) => {
    if (!agentId) return;
    setSaving(true); setError(null);
    const { error } = await supabase
      .from('agents')
      .update({ department: next })
      .eq('id', agentId);
    setSaving(false);
    if (error) { setError(error.message); return; }
    setDept(next);
    setEditing(false);
    onDepartmentChange?.(next);
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-violet-500/20 flex items-center justify-center flex-shrink-0">
            <span className="text-xl font-bold text-violet-300">{getInitial(name)}</span>
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h2 className="text-lg font-poppins font-bold text-white">{name}</h2>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusColor}`}>
                {status === 'online' ? 'Active Now' : status === 'idle' ? 'Idle' : 'Offline'}
              </span>
              <div className="relative" ref={wrapRef}>
                <button
                  onClick={() => setEditing(!editing)}
                  disabled={saving}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium ${pillClass} flex items-center gap-1.5 cursor-pointer hover:opacity-90 disabled:opacity-50`}
                >
                  {currentDeptRow?.color && <span className={`w-2 h-2 rounded-full ${COLOR_DOT[currentDeptRow.color] ?? 'bg-gray-400'}`} />}
                  {dept ?? 'Unassigned'}
                  <i className="ri-arrow-down-s-line" />
                </button>
                {editing && (
                  <div className="absolute top-full left-0 mt-1 bg-dark-800 border border-dark-700 rounded-lg shadow-xl py-1 min-w-[180px] z-30 overflow-hidden">
                    <button
                      onClick={() => assign(null)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                        dept === null ? 'text-cyan-300 bg-cyan-500/10' : 'text-gray-200 hover:bg-dark-700'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-gray-500" />
                      Unassigned
                      {dept === null && <i className="ri-check-line text-[12px] ml-auto" />}
                    </button>
                    {departments.length > 0 && <div className="my-1 border-t border-dark-700" />}
                    {departments.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => assign(d.name)}
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                          d.name === dept ? 'text-cyan-300 bg-cyan-500/10' : 'text-gray-200 hover:bg-dark-700'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full ${COLOR_DOT[d.color ?? ''] ?? 'bg-gray-400'}`} />
                        {d.name}
                        {d.name === dept && <i className="ri-check-line text-[12px] ml-auto" />}
                      </button>
                    ))}
                    <div className="border-t border-dark-700 mt-1">
                      <button
                        onClick={() => { setEditing(false); navigate('/admin-portal?tab=departments'); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-cyan-300 hover:bg-dark-700 flex items-center gap-2"
                      >
                        <i className="ri-add-line" /> Manage departments
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {error && <p className="text-[11px] text-red-400 mb-1">{error}</p>}
            <div className="flex items-center gap-3 text-xs text-gray-300 flex-wrap">
              <span className="flex items-center gap-1">
                <i className="ri-computer-line" /> {machine}
              </span>
              <span className="flex items-center gap-1">
                <i className="ri-code-s-slash-line" /> {version}
              </span>
              <span className="flex items-center gap-1">
                <i className="ri-wifi-line" /> {ipAddress}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => navigate('/dashboard')}
            className="px-3 py-1.5 rounded-lg border border-dark-600 text-gray-200 text-xs font-medium hover:bg-dark-700 transition-colors flex items-center gap-1.5"
          >
            <i className="ri-arrow-left-line" /> All Agents
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 text-xs font-medium hover:bg-red-500/10 transition-colors flex items-center gap-1.5">
            <i className="ri-delete-bin-line" /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}
