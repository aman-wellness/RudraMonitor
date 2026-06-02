// IT hardware inventory — laptops, desktops, peripherals.
//   • Inventory tab: list + filter + CSV upload + manual add + edit + assign/unassign
//   • Dashboard tab: status counts, total value per currency, by-type + by-brand splits
//
// Offboarding stage 2 auto-unassigns devices held by the exiting employee
// (see supabase/functions/offboarding/index.ts), so this page is the
// admin-side counterpart for everyday inventory management.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

type Asset = {
  id: string;
  org_id: string;
  device_serial: string;
  device_tag: string | null;
  device_type: 'laptop' | 'desktop' | 'monitor' | 'phone' | 'tablet' | 'accessory' | 'other';
  configuration: string | null;
  ram_gb: number | null;
  disk_gb: number | null;
  brand: string | null;
  model: string | null;
  purchase_price: number | null;
  purchase_currency: string | null;
  purchase_date: string | null;
  assigned_employee_id: string | null;
  assigned_at: string | null;
  unassigned_at: string | null;
  status: 'in_stock' | 'assigned' | 'retired' | 'lost' | 'rma';
  notes: string | null;
  created_at: string;
};
type OrgUser = {
  row_id: string;
  display_name: string;
  work_email: string | null;
  employee_id: string | null;
  provider: 'm365' | 'google' | null;
  m365_user_id: string | null;
  google_user_id: string | null;
  has_rudrans_record: boolean;
  doj?: string | null;
  lwd?: string | null;
};

type AssignmentHistory = {
  id: string;
  asset_id: string;
  employee_id: string | null;
  assigned_at: string;
  unassigned_at: string | null;
  unassign_reason: string | null;
};

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'];
const DEVICE_TYPES: Asset['device_type'][] = ['laptop', 'desktop', 'monitor', 'phone', 'tablet', 'accessory', 'other'];

const empty: Partial<Asset> = {
  device_serial: '', device_tag: '', device_type: 'laptop', configuration: '',
  ram_gb: null, disk_gb: null, brand: '', model: '',
  purchase_price: null, purchase_currency: 'INR', purchase_date: null,
  notes: '', status: 'in_stock',
};

const STATUS_TINT: Record<Asset['status'], string> = {
  in_stock: 'bg-emerald-500/15 text-emerald-400',
  assigned: 'bg-blue-500/15 text-blue-400',
  retired:  'bg-gray-500/15 text-gray-400',
  lost:     'bg-rose-500/15 text-rose-400',
  rma:      'bg-amber-500/15 text-amber-400',
};

export default function HardwareInventory() {
  const [rows, setRows] = useState<Asset[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'inventory' | 'dashboard'>('inventory');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Asset['status']>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | Asset['device_type']>('all');
  const [editing, setEditing] = useState<Partial<Asset> | null>(null);
  const [assignFor, setAssignFor] = useState<Asset | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<Asset | null>(null);
  const [historyRows, setHistoryRows] = useState<AssignmentHistory[]>([]);
  const [assetHistoryCounts, setAssetHistoryCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [a, u, e, h] = await Promise.all([
      // Explicit range so we get every device (PostgREST defaults to 1000;
      // setting a high range up-front avoids hitting the cap on bigger fleets).
      supabase.from('hardware_assets').select('*').order('created_at', { ascending: false }).range(0, 9999),
      // Include offboarded employees so we can still show last assignee + their lwd.
      supabase.from('v_org_users')
        .select('row_id, display_name, work_email, employee_id, provider, m365_user_id, google_user_id, has_rudrans_record')
        .order('display_name').range(0, 9999),
      supabase.from('employees').select('id, doj, lwd, status').range(0, 9999),
      supabase.from('hardware_assignments').select('asset_id').range(0, 9999),
    ]);
    setRows((a.data ?? []) as Asset[]);

    // Stitch employee.doj / lwd onto org-user rows so the inventory table can
    // render Join / Exit dates inline.
    const empMeta = new Map<string, { doj: string | null; lwd: string | null }>();
    for (const e1 of (e.data ?? []) as Array<{ id: string; doj: string | null; lwd: string | null }>) {
      empMeta.set(e1.id, { doj: e1.doj, lwd: e1.lwd });
    }
    const usersHydrated = ((u.data ?? []) as OrgUser[]).map((x) => ({
      ...x,
      doj: x.employee_id ? empMeta.get(x.employee_id)?.doj ?? null : null,
      lwd: x.employee_id ? empMeta.get(x.employee_id)?.lwd ?? null : null,
    }));
    setUsers(usersHydrated);

    // Per-asset history count for the new "History" column. We count every
    // hardware_assignments row regardless of unassigned_at — the row count IS
    // the number of times this device has been assigned over its lifetime.
    const counts: Record<string, number> = {};
    for (const row of (h.data ?? []) as Array<{ asset_id: string }>) {
      counts[row.asset_id] = (counts[row.asset_id] ?? 0) + 1;
    }
    setAssetHistoryCounts(counts);

    setLoading(false);
  }, []);

  const openHistory = async (asset: Asset) => {
    setHistoryFor(asset);
    const { data } = await supabase
      .from('hardware_assignments')
      .select('id, asset_id, employee_id, assigned_at, unassigned_at, unassign_reason')
      .eq('asset_id', asset.id)
      .order('assigned_at', { ascending: false });
    setHistoryRows((data ?? []) as AssignmentHistory[]);
  };

  useEffect(() => { load(); }, [load]);

  const userByEmpId = useMemo(() => {
    const m = new Map<string, OrgUser>();
    for (const u of users) if (u.employee_id) m.set(u.employee_id, u);
    return m;
  }, [users]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      // Lowercase-compare so CSV imports with "Assigned" / "Laptop" / etc.
      // match the dropdown values without case-sensitivity issues.
      const rowStatus = String(r.status ?? '').toLowerCase();
      const rowType = String(r.device_type ?? '').toLowerCase();
      if (statusFilter !== 'all' && rowStatus !== statusFilter) return false;
      if (typeFilter !== 'all' && rowType !== typeFilter) return false;
      if (!ql) return true;
      return [r.device_serial, r.device_tag, r.brand, r.model, r.configuration, r.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(ql);
    });
  }, [rows, q, statusFilter, typeFilter]);

  // ---------- pagination ----------
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  // Reset to page 1 whenever filters change so the user doesn't end up on a
  // page that no longer exists.
  useEffect(() => { setPage(1); }, [q, statusFilter, typeFilter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">IT Hardware Inventory</h1>
            <p className="text-sm text-gray-400">
              Laptops, desktops, peripherals — assignment + value tracking. Offboarding stage 2 auto-unassigns devices.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/employees" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">Back to employees</Link>
            <button
              onClick={() => exportHardwareCsv(filtered, userByEmpId)}
              disabled={filtered.length === 0}
              className="px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-sm text-white"
            >
              <i className="ri-file-download-line mr-1" /> Export CSV
            </button>
            <button onClick={() => setCsvOpen(true)} className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">
              <i className="ri-file-upload-line mr-1" /> Upload CSV
            </button>
            <button onClick={() => setEditing({ ...empty })} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
              <i className="ri-add-line mr-1" /> Add device
            </button>
          </div>
        </header>

        <div className="mb-4 flex gap-1 border-b border-dark-700">
          {(['inventory', 'dashboard'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-emerald-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              {t === 'inventory' ? 'Inventory' : 'Dashboard'}
            </button>
          ))}
        </div>

        {tab === 'dashboard' ? (
          <HardwareDashboard rows={rows} />
        ) : (
          <div className="bg-dark-800 border border-dark-700 rounded-xl">
            <div className="p-4 flex flex-col md:flex-row gap-3 md:items-center border-b border-dark-700">
              <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
                <i className="ri-search-line text-gray-500 text-sm mr-2" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search serial, tag, brand, model, config…"
                  className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
                <option value="all">All statuses</option>
                <option value="in_stock">In stock</option>
                <option value="assigned">Assigned</option>
                <option value="retired">Retired</option>
                <option value="lost">Lost</option>
                <option value="rma">RMA</option>
              </select>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
                <option value="all">All types</option>
                {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 uppercase tracking-wider">
                  <tr className="border-b border-dark-700">
                    <th className="px-4 py-3 text-left font-medium">Tag / Serial</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-left font-medium">Brand · Model</th>
                    <th className="px-4 py-3 text-left font-medium">Spec</th>
                    <th className="px-4 py-3 text-left font-medium">Assigned to</th>
                    <th className="px-4 py-3 text-left font-medium">Join</th>
                    <th className="px-4 py-3 text-left font-medium">Exit</th>
                    <th className="px-4 py-3 text-right font-medium">History</th>
                    <th className="px-4 py-3 text-right font-medium">Price</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={11} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
                  ) : filtered.length === 0 ? (
                    <tr><td colSpan={11} className="px-4 py-10 text-center text-sm text-gray-500">
                      No devices yet. Add manually or upload a CSV to bootstrap your inventory.
                    </td></tr>
                  ) : pageRows.map((r) => {
                    const u = r.assigned_employee_id ? userByEmpId.get(r.assigned_employee_id) : null;
                    return (
                      <tr key={r.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                        <td className="px-4 py-3">
                          <p className="text-white text-xs">{r.device_tag ?? '—'}</p>
                          <p className="text-gray-500 text-xs font-mono">{r.device_serial}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-300">{r.device_type}</td>
                        <td className="px-4 py-3 text-gray-300">{[r.brand, r.model].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-xs">
                          {[r.ram_gb && `${r.ram_gb}GB RAM`, r.disk_gb && `${r.disk_gb}GB`, r.configuration]
                            .filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {u ? (
                            <div>
                              <p className="text-sm text-white">{u.display_name}</p>
                              <p className="text-xs text-gray-500">{u.work_email ?? '—'}</p>
                            </div>
                          ) : <span className="text-gray-500">—</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {u?.doj ? new Date(u.doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {u?.lwd
                            ? <span className="text-rose-300">{new Date(u.lwd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                            : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => openHistory(r)}
                            className="px-2 py-0.5 rounded-md text-[11px] bg-dark-700 text-gray-300 hover:bg-dark-600 border border-dark-600"
                            title="View previous assignments"
                          >
                            {assetHistoryCounts[r.id] ?? 0}×
                          </button>
                        </td>
                        <td className="px-4 py-3 text-gray-300 text-right">
                          {r.purchase_price != null
                            ? `${r.purchase_currency ?? ''} ${r.purchase_price.toLocaleString()}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-1 rounded-full ${STATUS_TINT[r.status]}`}>{r.status.replace('_', ' ')}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-3">
                            <button onClick={() => setAssignFor(r)} className="text-xs text-blue-400 hover:text-blue-300">
                              {r.status === 'assigned' ? 'Reassign' : 'Assign'}
                            </button>
                            <button onClick={() => setEditing({ ...r })} className="text-xs text-emerald-400 hover:text-emerald-300">Edit</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-dark-700 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-gray-500">
                {filtered.length === 0
                  ? `0 of ${rows.length} devices`
                  : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} of ${filtered.length}${filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ''}`}
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage(1)} disabled={page === 1}
                    className="px-2 py-1 rounded-md text-[11px] bg-dark-700 text-gray-300 hover:bg-dark-600 disabled:opacity-40"
                  >
                    « First
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-2 py-1 rounded-md text-[11px] bg-dark-700 text-gray-300 hover:bg-dark-600 disabled:opacity-40"
                  >
                    ‹ Prev
                  </button>
                  <span className="px-2 py-1 text-[11px] text-gray-400">Page {page} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="px-2 py-1 rounded-md text-[11px] bg-dark-700 text-gray-300 hover:bg-dark-600 disabled:opacity-40"
                  >
                    Next ›
                  </button>
                  <button
                    onClick={() => setPage(totalPages)} disabled={page === totalPages}
                    className="px-2 py-1 rounded-md text-[11px] bg-dark-700 text-gray-300 hover:bg-dark-600 disabled:opacity-40"
                  >
                    Last »
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {editing && (
        <AssetModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
      {assignFor && (
        <AssignModal
          asset={assignFor}
          users={users}
          onClose={() => setAssignFor(null)}
          onDone={async () => { setAssignFor(null); await load(); }}
        />
      )}
      {historyFor && (
        <HistoryDrawer
          asset={historyFor}
          rows={historyRows}
          users={users}
          onClose={() => { setHistoryFor(null); setHistoryRows([]); }}
        />
      )}

      {csvOpen && (
        <CsvImportModal
          onClose={() => setCsvOpen(false)}
          onDone={async () => { setCsvOpen(false); await load(); }}
        />
      )}
    </DashboardLayout>
  );
}

// ============== Asset add/edit modal ==============

function AssetModal({ row, onClose, onSaved }: { row: Partial<Asset>; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState(row);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/asset-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: f.id, device_serial: f.device_serial, device_tag: f.device_tag,
          device_type: f.device_type, configuration: f.configuration,
          ram_gb: f.ram_gb, disk_gb: f.disk_gb, brand: f.brand, model: f.model,
          purchase_price: f.purchase_price, purchase_currency: f.purchase_currency,
          purchase_date: f.purchase_date, notes: f.notes, status: f.status,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={f.id ? 'Edit device' : 'New device'} onClose={onClose} footer={
      <>
        <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
        <button onClick={save} disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </>
    }>
      {err && <Err msg={err} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Device serial *">
          <Input value={f.device_serial ?? ''} onChange={(v) => setF({ ...f, device_serial: v })} placeholder="C02XX1234567" />
        </Field>
        <Field label="Tag / Asset No.">
          <Input value={f.device_tag ?? ''} onChange={(v) => setF({ ...f, device_tag: v })} placeholder="RUD-LT-042" />
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <DeviceTypeField value={f.device_type ?? 'laptop'} onChange={(v) => setF({ ...f, device_type: v as Asset['device_type'] })} />
        <Field label="Brand">
          <Input value={f.brand ?? ''} onChange={(v) => setF({ ...f, brand: v })} placeholder="Apple" />
        </Field>
        <Field label="Model">
          <Input value={f.model ?? ''} onChange={(v) => setF({ ...f, model: v })} placeholder="MacBook Pro 14" />
        </Field>
      </div>
      <Field label="Configuration (free text)">
        <Input value={f.configuration ?? ''} onChange={(v) => setF({ ...f, configuration: v })} placeholder="M3 Pro 12-core CPU / 16-core GPU" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="RAM (GB)">
          <Input type="number" value={String(f.ram_gb ?? '')} onChange={(v) => setF({ ...f, ram_gb: v === '' ? null : Number(v) })} placeholder="16" />
        </Field>
        <Field label="Disk (GB)">
          <Input type="number" value={String(f.disk_gb ?? '')} onChange={(v) => setF({ ...f, disk_gb: v === '' ? null : Number(v) })} placeholder="512" />
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Purchase price">
          <Input type="number" value={String(f.purchase_price ?? '')} onChange={(v) => setF({ ...f, purchase_price: v === '' ? null : Number(v) })} placeholder="125000" />
        </Field>
        <Field label="Currency">
          <select value={f.purchase_currency ?? 'INR'} onChange={(e) => setF({ ...f, purchase_currency: e.target.value })} className={inputCls}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Purchase date">
          <Input type="date" value={f.purchase_date ?? ''} onChange={(v) => setF({ ...f, purchase_date: v })} />
        </Field>
      </div>
      <Field label="Status">
        <select value={f.status ?? 'in_stock'} onChange={(e) => setF({ ...f, status: e.target.value as Asset['status'] })} className={inputCls}>
          <option value="in_stock">In stock</option>
          <option value="assigned">Assigned</option>
          <option value="retired">Retired</option>
          <option value="lost">Lost</option>
          <option value="rma">RMA</option>
        </select>
      </Field>
      <Field label="Notes">
        <textarea value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} className={`${inputCls} h-16 resize-none`} placeholder="Battery cycles, scratches, warranty etc." />
      </Field>
    </Modal>
  );
}

// Device-type picker. The dropdown lists the canonical short list; picking
// "other" reveals a free-text input the admin can use to capture niche assets
// (e.g. "headset", "yubikey", "Apple Pencil"). The custom string is saved
// verbatim into device_type — the schema accepts any text now.
function DeviceTypeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = (DEVICE_TYPES as string[]).includes(value);
  // 'other' triggers the input. We also enter that mode if the current value
  // isn't one of the presets (e.g. when editing a row saved earlier).
  const [mode, setMode] = useState<'preset' | 'custom'>(isPreset && value !== 'other' ? 'preset' : 'custom');
  const [custom, setCustom] = useState(isPreset ? '' : value);

  return (
    <Field label="Type">
      {mode === 'preset' ? (
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'other') {
              setMode('custom');
              // Keep onChange synced to whatever the admin types next; default to empty.
              setCustom('');
              onChange('');
            } else {
              onChange(v);
            }
          }}
          className={inputCls}
        >
          {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      ) : (
        <div className="flex gap-1">
          <input
            value={custom}
            onChange={(e) => { setCustom(e.target.value); onChange(e.target.value); }}
            placeholder="e.g. headset, yubikey"
            className={inputCls}
            autoFocus
          />
          <button
            type="button"
            onClick={() => { setMode('preset'); setCustom(''); onChange('laptop'); }}
            className="px-2 text-xs text-gray-400 hover:text-white"
            title="Back to presets"
          >
            ↺
          </button>
        </div>
      )}
    </Field>
  );
}

// ============== Assign / unassign modal ==============

function AssignModal({ asset, users, onClose, onDone }: { asset: Asset; users: OrgUser[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [rowId, setRowId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAssigned = !!asset.assigned_employee_id;
  const currentUser = users.find((u) => u.employee_id === asset.assigned_employee_id);

  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/asset-assign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: asset.id, ...body }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={isAssigned ? 'Reassign / Unassign device' : 'Assign device'} onClose={onClose} footer={
      <>
        <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
        {isAssigned && (
          <button onClick={() => call({ unassign: true, reason: 'returned' })} disabled={busy}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg text-sm text-white">
            Unassign (return to stock)
          </button>
        )}
        <button onClick={() => rowId && call({ employee_row_id: rowId })} disabled={!rowId || busy}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
          {busy ? 'Saving…' : (isAssigned ? 'Reassign' : 'Assign')}
        </button>
      </>
    }>
      {err && <Err msg={err} />}
      <div className="text-sm text-gray-300 mb-2">
        <p><span className="text-gray-500">Device:</span> {asset.device_tag ?? asset.device_serial}</p>
        {isAssigned && currentUser && (
          <p className="mt-1"><span className="text-gray-500">Currently with:</span> <strong className="text-white">{currentUser.display_name}</strong> ({currentUser.work_email})</p>
        )}
      </div>
      <Field label={isAssigned ? 'Reassign to' : 'Assign to'}>
        <select value={rowId} onChange={(e) => setRowId(e.target.value)} className={inputCls}>
          <option value="">— pick user —</option>
          {users.map((u) => (
            <option key={u.row_id} value={u.row_id}>
              {u.display_name}{u.work_email ? ` · ${u.work_email}` : ''}{!u.has_rudrans_record ? ' (synced)' : ''}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

// ============== CSV import ==============

function CsvImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; updated: number; failed: number; outcomes: Array<{ index: number; ok: boolean; error?: string }> } | null>(null);

  const onFile = async (file: File) => {
    setErr(null); setResult(null); setFileName(file.name);
    try {
      const text = await file.text();
      setRows(parseCsv(text));
    } catch (e) {
      setErr(`Could not parse CSV: ${(e as Error).message}`);
      setRows([]);
    }
  };

  const submit = async () => {
    if (!rows.length) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/asset-bulk-import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setResult(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const header = 'device_serial,device_tag,device_type,brand,model,configuration,ram_gb,disk_gb,purchase_price,purchase_currency,purchase_date,status,notes';
    const sample = 'C02XX1234567,RUD-LT-042,laptop,Apple,MacBook Pro 14,M3 Pro 12c CPU 16c GPU,18,512,250000,INR,2025-06-15,in_stock,Issued with sleeve';
    const blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rudrans-hardware-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="Upload hardware inventory" onClose={onClose} footer={
      !result ? (
        <>
          <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button onClick={submit} disabled={!rows.length || busy}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </button>
        </>
      ) : (
        <button onClick={onDone} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">Done</button>
      )
    }>
      {err && <Err msg={err} />}
      {!result && (
        <>
          <button onClick={downloadTemplate} className="text-xs text-emerald-400 hover:text-emerald-300">
            <i className="ri-download-line mr-1" /> Download CSV template
          </button>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">CSV file</span>
            <input type="file" accept=".csv,text/csv"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              className="block w-full text-sm text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-dark-700 file:text-white hover:file:bg-dark-600 cursor-pointer" />
          </label>
          {fileName && (
            <p className="text-xs text-gray-500">{fileName} — {rows.length} row{rows.length === 1 ? '' : 's'} parsed. Existing devices (by serial) will be updated.</p>
          )}
        </>
      )}
      {result && (
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-emerald-400">{result.imported} new</span>
            {result.updated > 0 && <>, <span className="text-blue-400">{result.updated} updated</span></>}
            {result.failed > 0 && <>, <span className="text-rose-400">{result.failed} failed</span></>}
          </p>
          {result.failed > 0 && (
            <div className="border border-rose-500/30 bg-rose-500/5 rounded-lg p-2 max-h-40 overflow-y-auto text-xs">
              {result.outcomes.filter((o) => !o.ok).map((o) => (
                <p key={o.index} className="text-rose-300">Row {o.index + 1}: {o.error}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ============== Dashboard ==============

function HardwareDashboard({ rows }: { rows: Asset[] }) {
  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byType:   Record<string, number> = {};
    const byBrand:  Record<string, number> = {};
    const totalValue: Record<string, number> = {};   // currency → value
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byType[r.device_type] = (byType[r.device_type] ?? 0) + 1;
      if (r.brand) byBrand[r.brand] = (byBrand[r.brand] ?? 0) + 1;
      if (r.purchase_price != null && r.purchase_currency && r.status !== 'retired' && r.status !== 'lost') {
        totalValue[r.purchase_currency] = (totalValue[r.purchase_currency] ?? 0) + Number(r.purchase_price);
      }
    }
    return { byStatus, byType, byBrand, totalValue, total: rows.length };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total devices" value={stats.total} accent="text-white" />
        <Stat label="In stock" value={stats.byStatus.in_stock ?? 0} accent="text-emerald-400" />
        <Stat label="Assigned" value={stats.byStatus.assigned ?? 0} accent="text-blue-400" />
        <Stat label="Retired / Lost / RMA" value={(stats.byStatus.retired ?? 0) + (stats.byStatus.lost ?? 0) + (stats.byStatus.rma ?? 0)} accent="text-amber-400" />
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Active inventory value (excludes retired/lost)</p>
        {Object.keys(stats.totalValue).length === 0 ? (
          <p className="text-sm text-gray-500">No priced devices yet.</p>
        ) : (
          <div className="flex flex-wrap gap-4">
            {Object.entries(stats.totalValue).sort().map(([cur, v]) => (
              <div key={cur}>
                <p className="text-xs text-gray-500">{cur}</p>
                <p className="text-xl text-white font-semibold">{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BreakdownCard title="By type" data={stats.byType} />
        <BreakdownCard title="By brand" data={stats.byBrand} />
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}
function BreakdownCard({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">{title}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500">—</p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([k, n]) => (
            <li key={k} className="flex justify-between text-sm">
              <span className="text-white">{k}</span>
              <span className="text-gray-400">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============== Shared helpers ==============

const inputCls = "w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-gray-400 mb-1">{label}</span>{children}</label>;
}
function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputCls} />;
}
function Err({ msg }: { msg: string }) {
  return <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{msg}</div>;
}
function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <h2 className="text-lg text-white font-semibold">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">{children}</div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">{footer}</footer>
      </div>
    </div>
  );
}

// Minimal RFC-4180 CSV parser — same approach as credentials importer.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); row = []; cur = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else cur += c;
    }
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  if (rows.length < 2) throw new Error('CSV must have a header row and at least one data row');
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = (r[i] ?? '').trim();
    return obj;
  });
}

// ============== CSV export ==============
//
// Exports the currently-filtered list of devices. Joins assigned-to display
// name + email so the spreadsheet is self-contained — no extra vlookups
// needed for an HR/IT audit. Excel reads this CSV natively (open + UTF-8 BOM
// is prepended so non-ASCII names don't garble on Windows Excel).

function exportHardwareCsv(rows: Asset[], userByEmpId: Map<string, OrgUser>) {
  const headers = [
    'device_serial', 'device_tag', 'device_type', 'brand', 'model', 'configuration',
    'ram_gb', 'disk_gb', 'purchase_price', 'purchase_currency', 'purchase_date',
    'status', 'assigned_to_name', 'assigned_to_email', 'assigned_at', 'unassigned_at',
    'notes', 'created_at',
  ];
  const data = rows.map((r) => {
    const u = r.assigned_employee_id ? userByEmpId.get(r.assigned_employee_id) : null;
    return {
      device_serial: r.device_serial,
      device_tag: r.device_tag,
      device_type: r.device_type,
      brand: r.brand,
      model: r.model,
      configuration: r.configuration,
      ram_gb: r.ram_gb,
      disk_gb: r.disk_gb,
      purchase_price: r.purchase_price,
      purchase_currency: r.purchase_currency,
      purchase_date: r.purchase_date,
      status: r.status,
      assigned_to_name: u?.display_name ?? '',
      assigned_to_email: u?.work_email ?? '',
      assigned_at: r.assigned_at,
      unassigned_at: r.unassigned_at,
      notes: r.notes,
      created_at: r.created_at,
    };
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`rudrans-hardware-${stamp}.csv`, headers, data);
}

function downloadCsv(filename: string, headers: string[], rows: Record<string, unknown>[]) {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  // UTF-8 BOM so Windows Excel renders non-ASCII (₹ etc.) correctly.
  const csv = '﻿' + [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ============== assignment history drawer ==============
// Shows every previous (and current) assignment for a single asset, so IT can
// see who held a laptop / phone before reassigning it. Reads straight off
// hardware_assignments which is append-only.

function HistoryDrawer({
  asset, rows, users, onClose,
}: {
  asset: Asset;
  rows: AssignmentHistory[];
  users: OrgUser[];
  onClose: () => void;
}) {
  const empById = new Map<string, OrgUser>();
  for (const u of users) if (u.employee_id) empById.set(u.employee_id, u);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50">
      <div className="w-full md:max-w-2xl bg-dark-800 border border-dark-700 rounded-t-2xl md:rounded-2xl max-h-[85vh] overflow-y-auto">
        <header className="sticky top-0 bg-dark-800 border-b border-dark-700 px-5 py-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-cyan-300">Assignment history</p>
            <h2 className="text-lg text-white font-semibold mt-0.5">
              {asset.device_tag || asset.device_serial}
              <span className="text-gray-500 font-normal text-sm ml-2">{[asset.brand, asset.model].filter(Boolean).join(' · ')}</span>
            </h2>
            <p className="text-[11px] text-gray-500 font-mono mt-0.5">{asset.device_serial}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white">✕</button>
        </header>

        <div className="px-5 py-4">
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No assignment history yet — this device hasn't been assigned to anyone.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((r, idx) => {
                const u = r.employee_id ? empById.get(r.employee_id) : null;
                const isCurrent = !r.unassigned_at;
                return (
                  <div key={r.id} className={`px-4 py-3 rounded-lg border ${
                    isCurrent ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-dark-900/60 border-dark-700'
                  }`}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm text-white font-medium">{u?.display_name ?? <span className="text-gray-500">— unknown —</span>}</p>
                          {isCurrent && (
                            <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Current</span>
                          )}
                          {idx === 0 && !isCurrent && (
                            <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/30">Last</span>
                          )}
                        </div>
                        {u?.work_email && <p className="text-[11px] text-gray-500 mt-0.5">{u.work_email}</p>}
                      </div>
                      <div className="text-right text-[11px] text-gray-400 shrink-0">
                        <p>
                          {new Date(r.assigned_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                          {' → '}
                          {r.unassigned_at
                            ? new Date(r.unassigned_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                            : <span className="text-emerald-300">present</span>}
                        </p>
                        {r.unassign_reason && (
                          <p className="text-gray-500 mt-0.5 capitalize">{r.unassign_reason.replace(/_/g, ' ')}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-[10px] text-gray-600 text-center">
            History is append-only. Total {rows.length} assignment{rows.length === 1 ? '' : 's'} recorded.
          </p>
        </div>
      </div>
    </div>
  );
}
