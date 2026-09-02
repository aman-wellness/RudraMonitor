// Agent-detail Inventory tab. Reads the latest row from agent_inventory
// for this specific agent and renders every collected section: hardware,
// Windows license (edition + OEM key + partial installed key), disks with
// SMART predict-failure status, battery health, installed software list,
// and the last N Windows event-log critical/error entries. Baseline
// feature (no plan gating) — the raw view of what the installed agent
// is reporting.
//
// The IT Hardware register cross-link (matched asset row, assigned employee)
// is an add-on; see hardware page's InventoryDrawer for the gated version.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type InventoryRow = {
  hardware: Record<string, unknown> | null;
  software: Array<{
    name?: string;
    version?: string;
    publisher?: string;
    install_date?: string;
  }> | null;
  battery: Record<string, unknown> | null;
  system_events: Array<{
    time?: string;
    event_id?: number;
    level?: string;
    source?: string;
    message?: string;
  }> | null;
  summary: Record<string, unknown> | null;
  collected_at: string;
};

export default function AgentInventoryTab({ agentId }: { agentId: string }) {
  const [row, setRow] = useState<InventoryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [softwareQ, setSoftwareQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const reload = async () => {
    const { data, error } = await supabase
      .from('agent_inventory')
      .select('hardware, software, battery, system_events, summary, collected_at')
      .eq('agent_id', agentId)
      .order('collected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) setErr(error.message);
    else setErr(null);
    setRow((data as InventoryRow | null) ?? null);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const refreshNow = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('not signed in');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-inventory-refresh`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agent_id: agentId }),
        },
      );
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      setRefreshMsg('Refresh requested — new snapshot in ~10 s.');
      // Poll for the new row: current collected_at → new collected_at.
      const beforeIso = row?.collected_at ?? '';
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await reload();
        // reload updates `row` via setRow; peek at the freshest via a re-query.
        const { data: fresh } = await supabase
          .from('agent_inventory')
          .select('collected_at')
          .eq('agent_id', agentId)
          .order('collected_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (fresh?.collected_at && fresh.collected_at !== beforeIso) {
          setRefreshMsg('Updated.');
          break;
        }
      }
    } catch (e) {
      setRefreshMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  const filteredSoftware = useMemo(() => {
    if (!row?.software) return [];
    const q = softwareQ.trim().toLowerCase();
    if (!q) return row.software;
    return row.software.filter((s) =>
      (s.name ?? '').toLowerCase().includes(q)
      || (s.publisher ?? '').toLowerCase().includes(q)
    );
  }, [row?.software, softwareQ]);

  if (loading) {
    return (
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 text-sm text-gray-400 flex items-center gap-3">
        <span className="w-4 h-4 border-2 border-emerald-500/40 border-t-emerald-500 rounded-full animate-spin" />
        Loading inventory…
      </div>
    );
  }
  if (err) {
    return (
      <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-sm text-rose-300">
        Failed to load inventory: {err}
      </div>
    );
  }
  if (!row) {
    return (
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center text-sm text-gray-400">
        <p className="text-white text-base mb-1">Inventory not yet collected</p>
        <p>The agent posts a hardware + software + event-log snapshot within
          ~30 s of first launch and then once every 24 hours.</p>
        <p className="mt-2 text-xs text-gray-500">
          Requires agent v0.7.33 or newer.
        </p>
      </div>
    );
  }

  const hw = row.hardware ?? {};
  const s = (row.summary ?? {}) as {
    os_type?: string;
    disk_predict_fail?: boolean;
    event_error_count_24h?: number;
    battery_health_low?: boolean;
    battery_health_pct?: number | null;
    windows_licensed?: boolean;
    windows_edition?: string;
  };
  // Prefer summary.os_type, then fall back to hardware.os_type, then
  // hardware.os.name for the very first inventory rows that predate the
  // os_type addition.
  const osType = (
    s.os_type
    ?? (hw as { os_type?: string }).os_type
    ?? ((hw as { os?: { name?: string } }).os?.name?.toLowerCase().includes('mac') ? 'macos' : undefined)
    ?? 'windows'
  ).toLowerCase();
  const isMac = osType === 'macos' || osType === 'darwin';
  const battery = row.battery as {
    health_pct?: number | null;
    full_capacity_mwh?: number | null;
    design_capacity_mwh?: number | null;
    estimated_charge_pct?: number | null;
  } | null;
  const license = (hw as { license?: unknown }).license as {
    oem_product_key?: string | null;
    active_skus?: Array<{
      sku_name?: string;
      activation_channel?: string;
      partial_product_key?: string;
      full_product_key?: string | null;
      full_key_source?: 'decoded' | 'gvlk_public' | 'unavailable';
      license_status?: string;
      license_status_code?: number;
    }>;
  } | undefined;
  const disks = ((hw as { disks?: unknown[] }).disks ?? []) as Array<{
    model?: string;
    size_gb?: number;
    status?: string;
    predict_failure?: boolean;
    interface?: string;
    serial_number?: string;
  }>;
  const cpu = (hw as { cpu?: { name?: string; cores?: number; logical_processors?: number; max_clock_mhz?: number } }).cpu;
  const memory = (hw as { memory?: { total_gb?: number; slots?: Array<{ capacity_gb?: number; speed_mhz?: number; manufacturer?: string; slot?: string }> } }).memory;
  const os = (hw as { os?: { name?: string; version?: string; build?: string; architecture?: string; install_date?: string } }).os;
  const motherboard = (hw as { motherboard?: { manufacturer?: string; model?: string; serial_number?: string; version?: string } }).motherboard;
  const bios = (hw as { bios?: { manufacturer?: string; version?: string; smbios_version?: string; release_date?: string } }).bios;
  const gpus = ((hw as { gpu?: unknown[] }).gpu ?? []) as Array<{ name?: string; vram_bytes?: number; driver_version?: string }>;
  const nics = ((hw as { network_adapters?: unknown[] }).network_adapters ?? []) as Array<{ name?: string; mac_address?: string; speed_bps?: number }>;
  const systemSerial = (hw as { system_serial?: string }).system_serial;
  const events = row.system_events ?? [];

  return (
    <div className="space-y-4">
      {/* Header: risk chips + collected timestamp + refresh */}
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h3 className="text-white text-base font-semibold">System inventory</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Last collected {new Date(row.collected_at).toLocaleString()}
              {systemSerial && <> · Serial <span className="font-mono text-gray-400">{systemSerial}</span></>}
            </p>
            {refreshMsg && (
              <p className={`text-[11px] mt-1 ${refreshMsg.startsWith('Failed') ? 'text-rose-400' : 'text-emerald-400'}`}>
                {refreshMsg}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={refreshNow}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white shadow-md shadow-emerald-500/10 transition"
            title="Trigger an immediate inventory collection on the agent"
          >
            {refreshing ? (
              <>
                <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Refreshing…
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15A9 9 0 1 1 5.64 5.64L1 10" />
                </svg>
                Refresh now
              </>
            )}
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <Chip label="Disk" value={s.disk_predict_fail ? 'Predict fail' : 'OK'} tone={s.disk_predict_fail ? 'bad' : 'good'} />
          <Chip label="Battery" value={s.battery_health_pct != null ? `${s.battery_health_pct}%` : '—'} tone={s.battery_health_low ? 'warn' : s.battery_health_pct != null ? 'good' : 'muted'} />
          <Chip label="Errors 24h" value={String(s.event_error_count_24h ?? 0)} tone={(s.event_error_count_24h ?? 0) >= 10 ? 'warn' : 'muted'} />
          {isMac ? (
            <Chip
              label="macOS"
              value={
                (hw as { os?: { version?: string } }).os?.version ?? 'macOS'
              }
              tone="good"
            />
          ) : (
            <Chip
              label="Windows"
              value={s.windows_licensed ? 'Licensed' : 'Not activated'}
              tone={s.windows_licensed ? 'good' : 'warn'}
            />
          )}
        </div>
      </div>

      {/* Hardware */}
      <Card title="Hardware">
        {!cpu && !memory && !os && !motherboard && !bios && gpus.length === 0 && disks.length === 0 && (
          <p className="text-xs text-gray-500 py-2">
            Hardware not collected on this agent yet.{' '}
            {isMac ? (
              <>Mac inventory (system_profiler + pmset) lands in agent v0.7.39 — data will populate on the next daily cycle once the agent auto-updates, or click <strong>Refresh now</strong> above.</>
            ) : (
              <>Older Windows builds (before v0.7.38) used <code className="font-mono text-gray-400">wmic</code> which is deprecated on Windows 11 22H2+ — data will populate on the next daily cycle once the agent auto-updates, or click <strong>Refresh now</strong> above.</>
            )}
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {cpu && <KV k="CPU" v={`${cpu.name ?? '—'} · ${cpu.cores ?? '?'}c / ${cpu.logical_processors ?? '?'}t${cpu.max_clock_mhz ? ` · ${(cpu.max_clock_mhz / 1000).toFixed(1)} GHz` : ''}`} />}
          {memory && <KV k="Memory" v={`${memory.total_gb ?? '—'} GB total · ${(memory.slots ?? []).length} slot${(memory.slots ?? []).length === 1 ? '' : 's'}`} />}
          {os && <KV k="OS" v={`${os.name ?? '—'} · build ${os.build ?? '?'} · ${os.architecture ?? ''}`} />}
          {motherboard && <KV k="Motherboard" v={`${motherboard.manufacturer ?? ''} ${motherboard.model ?? ''}${motherboard.serial_number ? ` · s/n ${motherboard.serial_number}` : ''}`} />}
          {bios && <KV k="BIOS" v={`${bios.manufacturer ?? ''} ${bios.version ?? ''}${bios.release_date ? ` · ${bios.release_date.slice(0, 10)}` : ''}`} />}
          {gpus[0] && <KV k="GPU" v={`${gpus[0].name ?? '—'}${gpus[0].vram_bytes ? ` · ${Math.round((gpus[0].vram_bytes) / 1_073_741_824)} GB` : ''}`} />}
        </div>

        {(memory?.slots ?? []).length > 0 && (
          <details className="mt-3">
            <summary className="text-[11px] uppercase text-gray-500 cursor-pointer">Memory slots ({(memory?.slots ?? []).length})</summary>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(memory?.slots ?? []).map((slot, i) => (
                <div key={i} className="px-2.5 py-1.5 rounded bg-dark-900 border border-dark-700 text-xs">
                  <p className="text-white">{slot.capacity_gb ?? '—'} GB {slot.speed_mhz ? `· ${slot.speed_mhz} MHz` : ''}</p>
                  <p className="text-[10px] text-gray-500">{slot.manufacturer ?? '—'} · {slot.slot ?? '—'}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {disks.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] uppercase text-gray-500 mb-2">Disks</p>
            <div className="space-y-1.5">
              {disks.map((d, i) => (
                <div key={i} className={`flex items-center justify-between gap-3 px-3 py-2 rounded border ${d.predict_failure ? 'bg-rose-500/10 border-rose-500/30' : 'bg-dark-900 border-dark-700'}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-xs">{d.model ?? '—'}</p>
                    <p className="text-[10px] text-gray-500">
                      {d.size_gb ?? '—'} GB · {d.interface ?? '—'}
                      {d.serial_number && <> · s/n {d.serial_number}</>}
                    </p>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${d.predict_failure ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                    {d.status ?? '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {battery?.health_pct != null && (
          <div className="mt-4">
            <p className="text-[11px] uppercase text-gray-500 mb-1">Battery health</p>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-dark-950 rounded-full overflow-hidden">
                <div
                  className={`h-full ${battery.health_pct < 75 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.max(3, battery.health_pct)}%` }}
                />
              </div>
              <span className="text-xs text-gray-300 tabular-nums whitespace-nowrap">{battery.health_pct}%</span>
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {battery.full_capacity_mwh != null && <>Full charge {battery.full_capacity_mwh} mWh · </>}
              {battery.design_capacity_mwh != null && <>Design {battery.design_capacity_mwh} mWh</>}
            </p>
          </div>
        )}

        {nics.length > 0 && (
          <details className="mt-4">
            <summary className="text-[11px] uppercase text-gray-500 cursor-pointer">Network adapters ({nics.length})</summary>
            <div className="mt-2 space-y-1.5">
              {nics.map((n, i) => (
                <div key={i} className="px-2.5 py-1.5 rounded bg-dark-900 border border-dark-700 text-xs">
                  <p className="text-white">{n.name ?? '—'}</p>
                  <p className="text-[10px] text-gray-500">
                    {n.mac_address ?? '—'}
                    {n.speed_bps != null && n.speed_bps > 0 && <> · {(n.speed_bps / 1_000_000).toFixed(0)} Mbps</>}
                  </p>
                </div>
              ))}
            </div>
          </details>
        )}
      </Card>

      {/* Windows license — hidden on Mac */}
      {!isMac && license && (
        <Card title="Windows license">
          {license.oem_product_key ? (
            <div className="mb-3 px-3 py-2 rounded bg-emerald-500/5 border border-emerald-500/20">
              <p className="text-[10px] uppercase tracking-wide text-emerald-400 mb-0.5">OEM key (from UEFI BIOS)</p>
              <p className="font-mono text-sm text-emerald-200 select-all">{license.oem_product_key}</p>
            </div>
          ) : (
            <p className="text-xs text-gray-500 mb-3">No OEM key found in UEFI BIOS (machine was likely re-imaged onto generic media).</p>
          )}
          {(license.active_skus ?? []).map((sku, i) => (
            <div key={i} className="px-3 py-2 rounded bg-dark-900 border border-dark-700 mb-1.5 last:mb-0">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-white text-sm">{sku.sku_name ?? '—'}</p>
                  <p className="text-[11px] text-gray-500">Channel {sku.activation_channel ?? '—'}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${sku.license_status_code === 1 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                  {sku.license_status ?? '—'}
                </span>
              </div>
              {sku.full_product_key ? (
                <div className="mt-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-400 mb-0.5">
                    Product key {sku.full_key_source === 'gvlk_public' ? '(public KMS/GVLK)' : '(decoded from registry)'}
                  </p>
                  <p className="font-mono text-sm text-emerald-200 select-all break-all">{sku.full_product_key}</p>
                </div>
              ) : sku.partial_product_key ? (
                <p className="text-[11px] text-gray-500 mt-1">
                  Installed key ends in <span className="font-mono text-gray-300">…{sku.partial_product_key}</span>
                  <span className="text-[10px] text-gray-600 block mt-0.5">
                    Full retail key not retrievable — Microsoft anti-piracy limitation since Windows 10 1607.
                  </span>
                </p>
              ) : null}
            </div>
          ))}
        </Card>
      )}

      {/* Product licenses (Office / Visio / Project / non-Windows MS SKUs).
          Hidden on Mac — Apple hosts don't expose Microsoft SPP keys. */}
      {!isMac && (() => {
        const prod = ((hw as { product_licenses?: unknown[] }).product_licenses ?? []) as Array<{
          name?: string;
          partial_product_key?: string;
          full_product_key?: string | null;
          full_key_source?: 'decoded' | 'gvlk_public' | 'unavailable';
          activation_channel?: string;
          license_status?: string;
          license_status_code?: number;
        }>;
        if (prod.length === 0) return null;
        return (
          <Card title={`Software product keys (${prod.length})`}>
            <p className="text-[11px] text-gray-500 mb-2">
              Microsoft product keys tracked by SPP (Office, Visio, Project, etc.). Volume-license SKUs show the public KMS/GVLK key; retail keys are truncated to the last 5 chars by the OS.
            </p>
            <div className="space-y-1.5">
              {prod.map((sku, i) => (
                <div key={i} className="px-3 py-2 rounded bg-dark-900 border border-dark-700">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-white text-sm truncate">{sku.name ?? '—'}</p>
                      <p className="text-[11px] text-gray-500">Channel {sku.activation_channel ?? '—'}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${sku.license_status_code === 1 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                      {sku.license_status ?? '—'}
                    </span>
                  </div>
                  {sku.full_product_key ? (
                    <div className="mt-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-emerald-400 mb-0.5">
                        Product key {sku.full_key_source === 'gvlk_public' ? '(public KMS/GVLK)' : '(decoded)'}
                      </p>
                      <p className="font-mono text-sm text-emerald-200 select-all break-all">{sku.full_product_key}</p>
                    </div>
                  ) : sku.partial_product_key ? (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Key ends in <span className="font-mono text-gray-300">…{sku.partial_product_key}</span>
                      <span className="text-[10px] text-gray-600 block mt-0.5">
                        Full retail key not retrievable via any OS API.
                      </span>
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      {/* Installed software */}
      {row.software && row.software.length > 0 && (
        <Card title={`Installed software (${row.software.length})`}>
          <input
            value={softwareQ}
            onChange={(e) => setSoftwareQ(e.target.value)}
            placeholder="Search name or publisher…"
            className="w-full px-3 py-2 mb-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
          />
          <div className="border border-dark-700 rounded-lg overflow-hidden">
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-dark-900 text-[10px] uppercase text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Version</th>
                    <th className="text-left px-3 py-2 font-medium">Publisher</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSoftware.slice(0, 300).map((sw, i) => (
                    <tr key={i} className="border-t border-dark-700/50">
                      <td className="px-3 py-1.5 text-white text-xs truncate max-w-xs" title={sw.name}>{sw.name ?? '—'}</td>
                      <td className="px-3 py-1.5 text-gray-400 text-xs font-mono">{sw.version ?? '—'}</td>
                      <td className="px-3 py-1.5 text-gray-500 text-xs truncate max-w-xs">{sw.publisher ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {filteredSoftware.length > 300 && (
            <p className="text-[10px] text-gray-500 mt-1">Showing first 300 of {filteredSoftware.length} matching entries — narrow the search.</p>
          )}
        </Card>
      )}

      {/* System events */}
      {events.length > 0 && (
        <Card title={`Recent system errors (${events.length})`}>
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {events.map((ev, i) => (
              <div key={i} className={`px-3 py-2 rounded border text-xs ${ev.level === 'critical' ? 'bg-rose-500/10 border-rose-500/30' : 'bg-amber-500/5 border-amber-500/20'}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap mb-0.5">
                  <span className="text-white">{ev.source ?? '—'} · #{ev.event_id ?? '?'}</span>
                  <span className="text-[10px] text-gray-500">{ev.time ? new Date(ev.time).toLocaleString() : ''}</span>
                </div>
                {ev.message && <p className="text-[11px] text-gray-400 line-clamp-3">{ev.message}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <h3 className="text-white text-sm font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Chip({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'bad' | 'muted' }) {
  const cls = {
    good: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    bad: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    muted: 'bg-dark-900 text-gray-400 border-dark-700',
  }[tone];
  return (
    <div className={`px-3 py-2 rounded-lg border ${cls}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-sm font-medium mt-0.5">{value}</p>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="text-xs">
      <p className="text-gray-500">{k}</p>
      <div className="text-gray-200 mt-0.5">{v}</div>
    </div>
  );
}
