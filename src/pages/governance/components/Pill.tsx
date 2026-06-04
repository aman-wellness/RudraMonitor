import type { CSSProperties } from 'react';
import { ROLE_PILL, STATUS_PILL, type GovRole, type GovPillarStatus } from '../types';

// Tiny presentational pill that mirrors the governance doc's CSS pills.
// Used for role badges (Owner/Admin/Editor/View/External) and pillar status
// (Filled/Hiring/Vacant/Archived).

export function RolePill({ role }: { role: GovRole }) {
  const p = ROLE_PILL[role];
  const style: CSSProperties = {
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
  };
  return (
    <span
      className="inline-block text-[10px] font-semibold tracking-wider px-2 py-[2px] rounded font-mono uppercase"
      style={style}
    >
      {p.label}
    </span>
  );
}

export function StatusPill({ status }: { status: GovPillarStatus }) {
  const p = STATUS_PILL[status];
  const style: CSSProperties = {
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
  };
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider px-2 py-[2px] rounded font-mono uppercase"
      style={style}
    >
      {status === 'hiring' && <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.border }} />}
      {p.label}
    </span>
  );
}

export function PillarDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block rounded-full flex-shrink-0"
      style={{ width: size, height: size, background: color }}
    />
  );
}
