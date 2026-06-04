import type { GovChannel } from '../types';

// Section 2 — Channel structure (Slack/Teams). Documentation only — we don't
// sync to the actual messaging platforms in v1.

interface Props {
  channels: GovChannel[];
  pillarNameById: Map<string, string>;
  memberCountById: Map<string, number>;
  onEditChannel?: (channelId: string) => void;
}

const LAYER_LABEL: Record<string, string> = {
  L1: 'L1 — Leadership',
  L2: 'L2 — Functional',
  L3: 'L3 — Sub',
};

export default function ChannelTable({ channels, pillarNameById, memberCountById, onEditChannel }: Props) {
  if (channels.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-6 text-center text-sm text-gray-500">
        No channels documented yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-dark-700">
      <table className="w-full text-sm">
        <thead className="bg-dark-800/60">
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400">
            <th className="px-4 py-3 w-32">Layer</th>
            <th className="px-4 py-3">Channel</th>
            <th className="px-4 py-3">Primary Pillar</th>
            <th className="px-4 py-3 w-20">Members</th>
            <th className="px-4 py-3">Purpose</th>
            {onEditChannel && <th className="px-4 py-3 w-12" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-dark-700 bg-dark-900/30">
          {channels.map((c) => (
            <tr key={c.id} className="hover:bg-dark-800/40">
              <td className="px-4 py-3 text-gray-500 text-xs">{LAYER_LABEL[c.layer]}</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center font-mono text-[12px] px-2 py-[3px] rounded border bg-dark-800/60 border-dark-700 text-gray-200">
                  <span className="text-emerald-400 font-bold">#</span>
                  {c.name.replace(/^#/, '')}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-300 text-xs">
                {c.primary_pillar_id ? pillarNameById.get(c.primary_pillar_id) ?? '—' : <span className="text-gray-500 italic">—</span>}
              </td>
              <td className="px-4 py-3 text-gray-300 text-xs">{memberCountById.get(c.id) ?? 0}</td>
              <td className="px-4 py-3 text-gray-400 text-xs">{c.purpose ?? <span className="italic">—</span>}</td>
              {onEditChannel && (
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onEditChannel(c.id)}
                    className="text-emerald-400 hover:text-emerald-300 text-xs"
                  >
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
