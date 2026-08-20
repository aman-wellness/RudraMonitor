import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  type DlpEvent,
  type DlpEventType,
  type DlpSeverity,
  type DlpSettings,
} from '@/lib/supabase';

/* DLP data for the whole page in one fetch.
 *
 * The page used to re-query on every tab switch, filtered server-side by
 * event_type — which meant it could only ever show the two types the tab bar
 * happened to name. `clipboard_exfil` events were being written to the table and
 * were unreachable in the UI: the Settings panel offers a "Clipboard
 * exfiltration" toggle, so an org could enable it, generate events, and never
 * see one.
 *
 * Fetching the org's recent events once and splitting them client-side fixes
 * that (the tab list is derived from what exists), gives every tab a real count,
 * and lets the summary strip describe the whole picture instead of one type.
 */

export type DlpRow = DlpEvent & { agents?: { agent_name: string } | null };

export const SEVERITIES: DlpSeverity[] = ['low', 'medium', 'high', 'critical'];

/** Severity → design token. Escalating, and defined once for the whole page. */
export const sevTone = (s: DlpSeverity | null): string => {
  switch (s) {
    case 'critical': return 'var(--d-danger)';
    case 'high': return 'var(--d-sev-high)';
    case 'medium': return 'var(--d-warning)';
    case 'low': return 'var(--d-success)';
    default: return 'var(--d-neutral)';
  }
};

/** Caption for an event type. Unknown types fall back to the raw value made
 *  readable, so a new type the agent starts emitting is still labelled. */
export const eventTypeLabel = (t: string) => {
  switch (t) {
    case 'usb_transfer': return 'USB transfers';
    case 'email_attachment': return 'Email attachments';
    case 'clipboard_exfil': return 'Clipboard';
    default: return t.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
};

export const eventTypeIcon = (t: string) => {
  switch (t) {
    case 'usb_transfer': return 'ri-usb-line';
    case 'email_attachment': return 'ri-mail-send-line';
    case 'clipboard_exfil': return 'ri-clipboard-line';
    default: return 'ri-shield-keyhole-line';
  }
};

/** Which types the org has switched on — used so an enabled-but-quiet channel
 *  still gets a tab (and can explain that it's quiet). */
const enabledTypes = (s: DlpSettings | null): DlpEventType[] => {
  if (!s) return [];
  const out: DlpEventType[] = [];
  if (s.usb_enabled) out.push('usb_transfer');
  if (s.email_enabled) out.push('email_attachment');
  if (s.clipboard_enabled) out.push('clipboard_exfil');
  return out;
};

export function useDlp() {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;
  const [rows, setRows] = useState<DlpRow[]>([]);
  const [settings, setSettings] = useState<DlpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    const [{ data: events, error: evErr }, { data: s }] = await Promise.all([
      supabase
        .from('dlp_events')
        .select('*, agents(agent_name)')
        .eq('org_id', orgId)
        .order('occurred_at', { ascending: false })
        .limit(500),
      supabase.from('dlp_settings').select('*').eq('org_id', orgId).maybeSingle(),
    ]);
    if (evErr) setError(evErr.message);
    else setError(null);
    setRows((events as unknown as DlpRow[]) ?? []);
    setSettings((s as DlpSettings | null) ?? null);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Realtime: any DLP event for this org re-reads the list.
  useEffect(() => {
    if (!orgId) return;
    const channel = supabase
      .channel(`dlp:${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dlp_events', filter: `org_id=eq.${orgId}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [orgId, refresh]);

  /** Event-type tabs: everything the data contains, plus everything the org has
   *  enabled, in a stable order. Never a hardcoded pair. */
  const types = useMemo(() => {
    const present = rows.map((r) => r.event_type as string);
    const ordered = ['usb_transfer', 'email_attachment', 'clipboard_exfil'];
    const all = Array.from(new Set([...present, ...enabledTypes(settings)]));
    return all.sort((a, b) => {
      const ia = ordered.indexOf(a), ib = ordered.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
  }, [rows, settings]);

  const countsByType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.event_type] = (m[r.event_type] ?? 0) + 1;
    return m;
  }, [rows]);

  const summary = useMemo(() => {
    const bySeverity: Record<DlpSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    let unclassified = 0;
    let unauthorized = 0;
    let alerted = 0;
    let queued = 0;
    for (const r of rows) {
      if (r.ai_severity) bySeverity[r.ai_severity] += 1;
      else unclassified += 1;
      if (r.ai_authorized === false) unauthorized += 1;
      if (r.alert_sent_at) alerted += 1;
      else if (r.ai_authorized === false) queued += 1;
    }
    const people = new Set(rows.map((r) => r.agents?.agent_name).filter(Boolean)).size;
    // Window the numbers actually describe: the oldest event we hold. Saying
    // "last 7 days" would be a guess — the query is capped by row count, not time.
    const oldest = rows.length ? rows[rows.length - 1].occurred_at : null;
    return { total: rows.length, bySeverity, unclassified, unauthorized, alerted, queued, people, oldest };
  }, [rows]);

  return { rows, settings, setSettings, types, countsByType, summary, loading, error, refresh, orgId };
}

/** Byte count → the largest unit that keeps it under four digits. */
export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
