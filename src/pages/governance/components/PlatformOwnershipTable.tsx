import type { GovPillarPlatform } from '../types';
import { PillarDot } from './Pill';

// Section 3 — Shared email ownership model. Maps platform → ownership email
// → pillar. Mirrors the doc's third table; this is the source-of-truth for
// "when X employee leaves, who keeps the keys?".

interface Props {
  platforms: GovPillarPlatform[];
  pillarById: Map<string, { name: string; color: string }>;
  onEditPlatform?: (platformId: string) => void;
}

export default function PlatformOwnershipTable({ platforms, pillarById, onEditPlatform }: Props) {
  if (platforms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-6 text-center text-sm text-gray-500">
        No platforms documented yet. Add platforms inside each pillar (Section 04).
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-dark-700">
      <table className="w-full text-sm">
        <thead className="bg-dark-800/60">
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400">
            <th className="px-4 py-3">Platform</th>
            <th className="px-4 py-3">Ownership Email</th>
            <th className="px-4 py-3">Pillar</th>
            <th className="px-4 py-3 w-32">IT Registered?</th>
            {onEditPlatform && <th className="px-4 py-3 w-12" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-dark-700 bg-dark-900/30">
          {platforms.map((p) => {
            const pl = pillarById.get(p.pillar_id);
            return (
              <tr key={p.id} className="hover:bg-dark-800/40">
                <td className="px-4 py-3 font-medium text-white">{p.platform_name}</td>
                <td className="px-4 py-3">
                  {p.ownership_email ? (
                    <span className="inline-block font-mono text-[11px] bg-blue-500/15 text-blue-300 border border-blue-500/30 rounded px-2 py-[2px]">
                      {p.ownership_email}
                    </span>
                  ) : (
                    <span className="text-gray-500 italic text-xs">not set</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {pl && (
                    <span className="inline-flex items-center gap-2 text-gray-300 text-xs">
                      <PillarDot color={pl.color} size={7} />
                      {pl.name}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  <div className="flex items-center gap-2">
                    {p.it_registered ? (
                      <span className="text-emerald-400">✓ Yes</span>
                    ) : (
                      <span className="text-gray-500">Pending</span>
                    )}
                    {p.credential_id && (
                      <a
                        href="/employees/credentials"
                        className="inline-flex items-center gap-1 text-[9px] font-semibold px-2 py-[2px] rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:bg-blue-500/25"
                        title="Linked to a Credentials Vault entry"
                      >
                        <i className="ri-key-2-line" /> Vault
                      </a>
                    )}
                  </div>
                </td>
                {onEditPlatform && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onEditPlatform(p.id)}
                      className="text-emerald-400 hover:text-emerald-300 text-xs"
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
