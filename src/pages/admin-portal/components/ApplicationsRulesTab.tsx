import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { usePagination } from '@/lib/usePagination';
import Pager from '@/components/Pager';

/* Applications & websites → productivity classification, optionally per department.

   This is the input side of the productivity number. The monitoring
   Applications/Browser tabs and the org_productivity_* RPCs all read
   productivity_rules; nothing here computes anything itself.

   A rule with no department is the organisation-wide default. A rule naming a
   department overrides that default for agents in it — which is the whole point
   of the feature: youtube.com can be productive for Content and unproductive
   for IT off one default plus one override. */

type MatchType = 'app' | 'host' | 'host_contains';
type Category = 'productive' | 'unproductive' | 'neutral' | 'prohibited';

type Rule = {
  id: string;
  org_id: string;
  match_type: MatchType;
  pattern: string;
  category: Category;
  department: string | null;
  created_at: string;
};

type FormState = {
  id?: string;
  match_type: MatchType;
  pattern: string;
  category: Category;
  department: string; // '' means all departments (stored as NULL)
};

const CATEGORY_STYLE: Record<Category, string> = {
  productive: 'text-emerald-400',
  unproductive: 'text-rose-400',
  neutral: 'text-gray-400',
  prohibited: 'text-orange-400',
};

const ALL_DEPARTMENTS = 'All departments';

const blankForm = (): FormState => ({
  match_type: 'app',
  pattern: '',
  category: 'productive',
  department: '',
});

interface Props {
  orgId: string | null;
}

export default function ApplicationsRulesTab({ orgId }: Props) {
  const [rows, setRows] = useState<Rule[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDel, setConfirmDel] = useState<Rule | null>(null);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');

  const load = async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);

    // The department list is the UNION of the configured departments and the
    // department strings agents actually report. agents.department is free text
    // with no foreign key, so the two can disagree — on the first deployment
    // this was built against, the only agent reported "IT" while
    // org_departments held HR/Support/Engineering/Sales. Offering only the
    // configured list would have made it impossible to write a rule for the
    // one department that had an agent in it.
    const [ruleRes, deptRes, agentRes] = await Promise.all([
      supabase.from('productivity_rules').select('*').eq('org_id', orgId)
        .order('match_type').order('pattern'),
      supabase.from('org_departments').select('name').eq('org_id', orgId),
      supabase.from('agents').select('department').eq('org_id', orgId),
    ]);

    if (ruleRes.error) setError(ruleRes.error.message);
    setRows((ruleRes.data as Rule[]) ?? []);

    const names = new Set<string>();
    for (const d of (deptRes.data ?? []) as Array<{ name: string | null }>) {
      if (d.name?.trim()) names.add(d.name.trim());
    }
    for (const a of (agentRes.data ?? []) as Array<{ department: string | null }>) {
      if (a.department?.trim()) names.add(a.department.trim());
    }
    setDepartments([...names].sort((a, b) => a.localeCompare(b)));
    setLoading(false);
  };

  useEffect(() => { void load(); }, [orgId]);

  const save = async () => {
    if (!editing || !orgId) return;
    setError(null);
    const pattern = editing.pattern.trim();
    if (!pattern) { setError('Enter an application name or website domain'); return; }

    const payload = {
      org_id: orgId,
      match_type: editing.match_type,
      pattern,
      category: editing.category,
      // Empty select value means "every department", stored as NULL so the
      // RPCs treat it as the fallback rule.
      department: editing.department.trim() || null,
    };

    const { error: err } = editing.id
      ? await supabase.from('productivity_rules').update(payload).eq('id', editing.id)
      : await supabase.from('productivity_rules').insert(payload);

    if (err) {
      // The unique key is (org_id, match_type, pattern, department) with NULLS
      // NOT DISTINCT, so re-adding the same scope is the most likely failure
      // and deserves a sentence rather than a Postgres error code.
      setError(
        err.code === '23505'
          ? `A rule for "${pattern}" already exists for ${payload.department ?? ALL_DEPARTMENTS.toLowerCase()}. Edit that rule instead.`
          : err.message,
      );
      return;
    }
    setEditing(null);
    await load();
  };

  const remove = async (r: Rule) => {
    setError(null);
    const { error: err } = await supabase.from('productivity_rules').delete().eq('id', r.id);
    if (err) { setError(err.message); return; }
    setConfirmDel(null);
    await load();
  };

  const filtered = useMemo(() => rows.filter((r) => {
    const matchDept =
      deptFilter === 'all' ||
      (deptFilter === '__none__' ? r.department === null : r.department === deptFilter);
    const matchSearch = !search || r.pattern.toLowerCase().includes(search.toLowerCase());
    return matchDept && matchSearch;
  }), [rows, deptFilter, search]);

  // 50 per page: the default catalogue seeds ~900 rules, so rendering every row
  // would produce a table nobody can navigate and a very slow first paint.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered, 50);

  // Surfaced under the heading: a rule naming a department nobody is in will
  // never classify anything, which is otherwise invisible until productivity
  // numbers fail to move.
  const agentDepartments = useMemo(() => new Set(departments), [departments]);
  const orphanRules = useMemo(
    () => rows.filter((r) => r.department && !agentDepartments.has(r.department)).length,
    [rows, agentDepartments],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Applications &amp; Websites</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Classify apps and sites as productive or unproductive. Set a department to override the
            organisation-wide default for that team only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
          >
            <option value="all">All scopes</option>
            <option value="__none__">{ALL_DEPARTMENTS} (default)</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 w-44"
          />
          <button
            onClick={() => setEditing(blankForm())}
            className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium whitespace-nowrap"
          >
            <i className="ri-add-line mr-1" /> New Rule
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {orphanRules > 0 && (
        <p className="text-amber-400 text-xs">
          <i className="ri-alert-line mr-1" />
          {orphanRules} rule{orphanRules === 1 ? '' : 's'} target a department no agent currently
          reports, so {orphanRules === 1 ? 'it' : 'they'} will not classify anything.
        </p>
      )}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[620px]">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-400">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Application / Website</th>
              <th className="text-left px-4 py-2.5 font-medium">Applies to</th>
              <th className="text-left px-4 py-2.5 font-medium">Category</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500 text-xs">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500 text-xs">
                  {rows.length === 0
                    ? 'No rules yet. Anything unclassified counts as neutral.'
                    : 'No rules match this filter.'}
                </td>
              </tr>
            ) : visible.map((r) => (
              <tr key={r.id} className="hover:bg-dark-900/40">
                <td className="px-4 py-2.5 text-gray-300 whitespace-nowrap">
                  <i className={`mr-1.5 ${
                    r.match_type === 'app' ? 'ri-window-line'
                      : r.match_type === 'host_contains' ? 'ri-search-line' : 'ri-global-line'
                  }`} />
                  {r.match_type === 'app' ? 'App'
                    : r.match_type === 'host_contains' ? 'Contains' : 'Website'}
                </td>
                <td className="px-4 py-2.5 text-white font-mono text-xs">{r.pattern}</td>
                <td className="px-4 py-2.5 text-gray-300 whitespace-nowrap">
                  {r.department ?? <span className="text-gray-500">{ALL_DEPARTMENTS}</span>}
                </td>
                <td className={`px-4 py-2.5 capitalize whitespace-nowrap ${CATEGORY_STYLE[r.category]}`}>
                  {r.category}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button
                    onClick={() => setEditing({
                      id: r.id,
                      match_type: r.match_type,
                      pattern: r.pattern,
                      category: r.category,
                      department: r.department ?? '',
                    })}
                    className="text-gray-400 hover:text-cyan-400 px-1.5"
                    title="Edit"
                  >
                    <i className="ri-pencil-line" />
                  </button>
                  <button
                    onClick={() => setConfirmDel(r)}
                    className="text-gray-400 hover:text-rose-400 px-1.5"
                    title="Delete"
                  >
                    <i className="ri-delete-bin-line" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="rules"
      />

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md p-5 space-y-4">
            <h3 className="text-white font-semibold text-sm">
              {editing.id ? 'Edit rule' : 'New rule'}
            </h3>

            <div className="space-y-1.5">
              <label className="text-[11px] text-gray-400">Match</label>
              <div className="flex gap-2">
                {(['app', 'host', 'host_contains'] as MatchType[]).map((mt) => (
                  <button
                    key={mt}
                    onClick={() => setEditing({ ...editing, match_type: mt })}
                    className={`flex-1 px-2 py-1.5 text-xs rounded-lg border ${
                      editing.match_type === mt
                        ? 'border-cyan-500 text-white bg-dark-900'
                        : 'border-dark-700 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {mt === 'app' ? 'Application'
                      : mt === 'host' ? 'Website' : 'Website contains'}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-gray-400">
                {editing.match_type === 'app' ? 'Application name'
                  : editing.match_type === 'host' ? 'Website domain' : 'Text in the hostname'}
              </label>
              <input
                value={editing.pattern}
                onChange={(e) => setEditing({ ...editing, pattern: e.target.value })}
                placeholder={editing.match_type === 'app' ? 'Code'
                  : editing.match_type === 'host' ? 'youtube.com' : 'vegamovie'}
                className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
              />
              <p className="text-[10px] text-gray-500">
                {editing.match_type === 'app'
                  ? 'Matched against the reported process name, case-insensitively — exactly as it appears in Live monitoring → Applications.'
                  : editing.match_type === 'host'
                    ? 'Matches this hostname and any subdomain of it, case-insensitively.'
                    : 'Matches anywhere in the hostname. Use this for sites that keep changing domain — "vegamovie" catches vegamovie.se, vegamovie.pe and vegamoviess.pro. Keep it distinctive: a short or common word will catch legitimate sites too.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-gray-400">Applies to</label>
              <select
                value={editing.department}
                onChange={(e) => setEditing({ ...editing, department: e.target.value })}
                className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="">{ALL_DEPARTMENTS} (default)</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-[10px] text-gray-500">
                A department rule overrides the {ALL_DEPARTMENTS.toLowerCase()} default for that team.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-gray-400">Category</label>
              <div className="flex gap-2">
                {(['productive', 'neutral', 'unproductive', 'prohibited'] as Category[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => setEditing({ ...editing, category: c })}
                    className={`flex-1 px-2 py-1.5 text-xs rounded-lg border capitalize ${
                      editing.category === c
                        ? 'border-cyan-500 text-white bg-dark-900'
                        : 'border-dark-700 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setEditing(null); setError(null); }}
                className="px-3 py-1.5 text-xs rounded-lg border border-dark-700 text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium"
              >
                {editing.id ? 'Save' : 'Add rule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-sm p-5 space-y-3">
            <h3 className="text-white font-semibold text-sm">Delete rule</h3>
            <p className="text-xs text-gray-400">
              <span className="font-mono text-gray-200">{confirmDel.pattern}</span> will fall back to{' '}
              {confirmDel.department
                ? `the ${ALL_DEPARTMENTS.toLowerCase()} rule, or neutral if there isn't one.`
                : 'neutral for every department without its own rule.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDel(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-dark-700 text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => void remove(confirmDel)}
                className="px-3 py-1.5 text-xs rounded-lg bg-rose-500 hover:bg-rose-400 text-white font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
