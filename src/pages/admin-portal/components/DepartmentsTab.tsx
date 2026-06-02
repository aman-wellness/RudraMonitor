import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Department = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  agent_count: number;
  color: string | null;
  created_at: string;
  updated_at: string;
};

type FormState = { id?: string; name: string; description: string; color: string };

const COLORS = [
  { value: 'emerald', dot: 'bg-emerald-500' },
  { value: 'cyan',    dot: 'bg-cyan-500' },
  { value: 'violet',  dot: 'bg-violet-500' },
  { value: 'amber',   dot: 'bg-amber-500' },
  { value: 'rose',    dot: 'bg-rose-500' },
  { value: 'blue',    dot: 'bg-blue-500' },
  { value: 'pink',    dot: 'bg-pink-500' },
  { value: 'teal',    dot: 'bg-teal-500' },
];

interface Props {
  orgId: string | null;
}

export default function DepartmentsTab({ orgId }: Props) {
  const [rows, setRows] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDel, setConfirmDel] = useState<Department | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    if (!orgId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('org_departments')
      .select('*')
      .eq('org_id', orgId)
      .order('name');
    if (error) setError(error.message);
    setRows((data as Department[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [orgId]);

  const save = async () => {
    if (!editing || !orgId) return;
    setError(null);
    const payload = {
      org_id: orgId,
      name: editing.name.trim(),
      description: editing.description.trim() || null,
      color: editing.color || null,
    };
    if (!payload.name) { setError('Department name is required'); return; }
    const { error } = editing.id
      ? await supabase.from('org_departments').update(payload).eq('id', editing.id)
      : await supabase.from('org_departments').insert(payload);
    if (error) { setError(error.message); return; }
    setEditing(null);
    await load();
  };

  const remove = async (d: Department) => {
    setError(null);
    const { error } = await supabase.from('org_departments').delete().eq('id', d.id);
    if (error) { setError(error.message); return; }
    setConfirmDel(null);
    await load();
  };

  const filtered = rows.filter((r) =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) ||
    (r.description ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Departments</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Categorise your agents by team. Used in agent listings, reports, and filters.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 w-44"
          />
          <button
            onClick={() => setEditing({ name: '', description: '', color: 'emerald' })}
            className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium"
          >
            <i className="ri-add-line mr-1" /> New Department
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left">Department</th>
              <th className="px-4 py-3 text-left">Description</th>
              <th className="px-4 py-3 text-right">Agents</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500 text-xs">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500 text-xs">
                {rows.length === 0
                  ? 'No departments yet. Click "+ New Department" to add your first.'
                  : 'No departments match your search.'}
              </td></tr>
            )}
            {filtered.map((d) => {
              const colorClass = COLORS.find((c) => c.value === d.color)?.dot ?? 'bg-gray-500';
              return (
                <tr key={d.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${colorClass}`} />
                      <span className="text-white font-medium">{d.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs max-w-md truncate" title={d.description ?? undefined}>
                    {d.description ?? <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-200 font-medium">{d.agent_count}</td>
                  <td className="px-4 py-3 text-gray-500 text-[11px]">
                    {new Date(d.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditing({
                          id: d.id,
                          name: d.name,
                          description: d.description ?? '',
                          color: d.color ?? 'emerald',
                        })}
                        className="px-2.5 py-1 text-[11px] rounded bg-dark-700 hover:bg-dark-600 text-gray-200"
                      >
                        <i className="ri-edit-2-line mr-1" /> Edit
                      </button>
                      <button
                        onClick={() => setConfirmDel(d)}
                        className="px-2.5 py-1 text-[11px] rounded bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30"
                      >
                        <i className="ri-delete-bin-line mr-1" /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="max-w-md w-full bg-dark-800 border border-dark-700 rounded-xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
              <h3 className="text-white font-semibold">{editing.id ? 'Edit Department' : 'New Department'}</h3>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-white">
                <i className="ri-close-line text-lg" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <Field label="Name *">
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. Sales, Engineering, Support"
                  className={inputCls}
                />
              </Field>
              <Field label="Description (optional)">
                <textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={2}
                  className={inputCls}
                />
              </Field>
              <Field label="Color">
                <div className="flex flex-wrap gap-2 mt-1">
                  {COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setEditing({ ...editing, color: c.value })}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                        editing.color === c.value ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-dark-800' : 'hover:scale-110'
                      }`}
                    >
                      <span className={`w-4 h-4 rounded-full ${c.dot}`} />
                    </button>
                  ))}
                </div>
              </Field>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setEditing(null)}
                  className="flex-1 px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-200 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={!editing.name.trim()}
                  className="flex-1 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium text-sm disabled:opacity-50"
                >
                  {editing.id ? 'Save Changes' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmDel(null)}>
          <div className="max-w-sm w-full bg-dark-800 border border-dark-700 rounded-xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-2">Remove department?</h3>
            <p className="text-sm text-gray-300 mb-4">
              <strong className="text-white">{confirmDel.name}</strong> will be deleted.
              {confirmDel.agent_count > 0 && (
                <span className="block mt-2 text-amber-400 text-xs">
                  ⚠️ {confirmDel.agent_count} agent(s) currently assigned — they'll keep the department text but lose the colour/description.
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDel(null)} className="flex-1 px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-200 text-sm">Cancel</button>
              <button onClick={() => remove(confirmDel)} className="flex-1 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium">Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-gray-400 uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
