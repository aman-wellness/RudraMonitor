import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

type Req = {
  id: string;
  org_id: string;
  requested_by: string;
  requested_at: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  org_name?: string;
  org_trial_plan_code?: string | null;
  org_trial_full_access?: boolean;
  requester_email?: string;
};

export default function TrialRequestsPage() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [rows, setRows] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ id: string; decision: 'approved' | 'denied' } | null>(null);
  const [note, setNote] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    const wantStatuses = tab === 'pending' ? ['pending'] : ['approved', 'denied', 'cancelled'];
    const { data, error } = await supabase
      .from('trial_extension_requests')
      .select(`
        id, org_id, requested_by, requested_at, reason, status,
        decided_by, decided_at, decision_note,
        organizations:org_id ( name, trial_plan_code, trial_full_access )
      `)
      .in('status', wantStatuses)
      .order('requested_at', { ascending: false });

    if (error) { setError(error.message); setLoading(false); return; }

    type Joined = Omit<Req, 'org_name' | 'org_trial_plan_code' | 'org_trial_full_access'> & {
      organizations: { name: string; trial_plan_code: string | null; trial_full_access: boolean } |
                     { name: string; trial_plan_code: string | null; trial_full_access: boolean }[] | null;
    };
    const flattened: Req[] = (data as Joined[] ?? []).map((r) => {
      const o = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
      return {
        id: r.id, org_id: r.org_id, requested_by: r.requested_by, requested_at: r.requested_at,
        reason: r.reason, status: r.status, decided_by: r.decided_by, decided_at: r.decided_at,
        decision_note: r.decision_note,
        org_name: o?.name, org_trial_plan_code: o?.trial_plan_code ?? null,
        org_trial_full_access: !!o?.trial_full_access,
      };
    });
    setRows(flattened);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [tab]);

  const decide = async (id: string, decision: 'approved' | 'denied', decisionNote: string) => {
    setBusyId(id); setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trial-extension-decide`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ request_id: id, decision, note: decisionNote }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed');
      await load();
      setNoteFor(null);
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AdminLayout title="Trial Requests">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-6">
          {(['pending', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm rounded-lg border ${
                tab === t ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                          : 'bg-dark-800 text-gray-400 border-dark-700 hover:text-white'
              }`}
            >
              {t === 'pending' ? 'Pending' : 'History'}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500">
            {tab === 'pending' ? 'No pending trial requests.' : 'No history yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/admin/customers/${r.org_id}`}
                          className="text-base text-white font-semibold hover:text-emerald-300">
                      {r.org_name ?? r.org_id}
                    </Link>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      Trial plan: <span className="text-gray-300">{r.org_trial_plan_code ?? '—'}</span>
                      {r.org_trial_full_access && (
                        <span className="ml-2 text-emerald-400">• full access granted</span>
                      )}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      Requested {new Date(r.requested_at).toLocaleString()}
                    </p>
                  </div>
                  <StatusBadge status={r.status} />
                </div>

                {r.reason && (
                  <p className="text-sm text-gray-300 mt-3 bg-dark-900 rounded-md p-3 border border-dark-700">
                    “{r.reason}”
                  </p>
                )}

                {r.status !== 'pending' && r.decision_note && (
                  <p className="text-xs text-gray-400 mt-2">
                    Decision note: {r.decision_note}
                  </p>
                )}

                {r.status === 'pending' && (
                  noteFor?.id === r.id ? (
                    <div className="mt-3">
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={2}
                        placeholder="Optional note for the customer (visible in their portal)"
                        className="w-full text-sm bg-dark-900 border border-dark-700 rounded-md px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => decide(r.id, noteFor.decision, note)}
                          disabled={busyId === r.id}
                          className={`text-sm px-3 py-1.5 rounded-md text-white disabled:opacity-50 ${
                            noteFor.decision === 'approved' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-rose-500 hover:bg-rose-600'
                          }`}
                        >
                          Confirm {noteFor.decision === 'approved' ? 'approve' : 'deny'}
                        </button>
                        <button
                          onClick={() => { setNoteFor(null); setNote(''); }}
                          disabled={busyId === r.id}
                          className="text-sm px-3 py-1.5 rounded-md bg-dark-700 text-gray-300 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => { setNoteFor({ id: r.id, decision: 'approved' }); setNote(''); }}
                        className="text-sm px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => { setNoteFor({ id: r.id, decision: 'denied' }); setNote(''); }}
                        className="text-sm px-3 py-1.5 rounded-md bg-rose-500 hover:bg-rose-600 text-white"
                      >
                        Deny
                      </button>
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

function StatusBadge({ status }: { status: Req['status'] }) {
  const tint: Record<Req['status'], string> = {
    pending:   'bg-amber-500/15 text-amber-300 border-amber-500/40',
    approved:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    denied:    'bg-rose-500/15 text-rose-300 border-rose-500/40',
    cancelled: 'bg-gray-500/15 text-gray-300 border-gray-500/40',
  };
  return <span className={`text-[11px] px-2.5 py-1 rounded-full border ${tint[status]}`}>{status}</span>;
}
