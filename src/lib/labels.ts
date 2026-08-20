/* Labels and colours DERIVED from stored values — no lookup tables.
 *
 * `alerts.alert_type` and `activity.activity_type` are open text columns written
 * by the agent (high_cpu, unauthorized_usb, idle_extended, offline, app,
 * browser, …). Any hand-written map of those strings to a caption or a colour
 * goes stale the moment the agent emits a kind nobody added to the map — and it
 * silently renders that new kind as whatever the map's default happens to be.
 *
 * So: the caption is a mechanical transform of the value itself, and the colour
 * is a stable hash of it. Every kind the agent can ever emit therefore gets a
 * readable name and its own consistent colour without anyone maintaining a list.
 */

/** "high_cpu" → "High CPU". Acronyms stay upper-case. */
export const prettyKind = (raw: string) => {
  const t = (raw ?? '').trim();
  if (!t) return '';
  return t
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Cpu|Gpu|Ram|Usb|Ai|Dlp|Os|Ip|Url|Id|Sla)\b/g, (m) => m.toUpperCase());
};

/**
 * Stable value → one of the eight categorical tokens. Same input always gives
 * the same colour, in both themes, and two different kinds are very unlikely to
 * collide in a list short enough for a human to read.
 *
 * Deliberately NOT a severity: nothing in `alerts` records severity, so a
 * red/amber/blue scale there would be invented. This encodes identity only.
 */
export const kindColor = (raw: string) => {
  const t = (raw ?? '').toLowerCase();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `var(--d-cat-${(h % 8) + 1})`;
};

/**
 * Seconds → the shortest unambiguous reading: "45s", "29m", "6h 31m".
 *
 * One formatter for the whole agent screen. It previously carried three:
 * "0:46:21" (h:mm:ss) for per-app time, "1122s" for event durations, and
 * "0h 46m" for the KPI strip — three renderings of the same quantity on one
 * page, two of them padded with a zero hour or an unconverted second count.
 */
export const formatDurationShort = (sec: number) => {
  const total = Math.max(0, Math.round(sec));
  if (total < 60) return `${total}s`;
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};

/**
 * How long ago, in the shortest honest form: "just now", "14m ago", "3h ago",
 * "2d ago". Third copy of this function in the app — the alerts page and the
 * agent-detail page each had their own, disagreeing on whether sub-minute is
 * "0 min ago" or "just now".
 */
export const formatRelative = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};
