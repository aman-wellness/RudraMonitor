import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  ReactFlow, Background, Controls, MiniMap, MarkerType,
  type Node, type Edge, type NodeProps, Handle, Position, BackgroundVariant,
  useNodesState, useEdgesState, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import dagre from 'dagre';
import { supabase } from '@/lib/supabase';
import AnimatedBackground, { BACKGROUND_OPTIONS, type BackgroundKey } from './AnimatedBackground';
import Avatar, { AVATAR_STYLE_OPTIONS, type AvatarStyle } from './Avatar';
import '@xyflow/react/dist/style.css';
import { confirmDialog, notify } from '@/lib/notify';

// Dropdown that renders to document.body via portal so it can never be
// clipped by an ancestor's `overflow: hidden`. Positions itself relative to
// the anchor button using getBoundingClientRect — that means it works the
// same in normal mode and full-screen mode.
function PortalDropdown({
  anchorRef, open, onClose, children, width = 260,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Compute a left-edge position that:
  //  • prefers aligning dropdown's right edge with the button's right edge
  //    (so it looks attached to the picker), BUT
  //  • won't extend past the left edge of the dashboard content area
  //    (avoids overlapping the sidebar / off-screen clipping).
  const measure = useCallback(() => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    // Sidebar in the dashboard layout is ~240px wide on desktop. Use the
    // chart wrap element to find the actual content-area left edge instead
    // of hardcoding.
    const chartLeftEdge = document.querySelector('.org-chart-wrap')?.getBoundingClientRect().left ?? 16;
    const preferredLeft = r.right - width;
    const safeLeft = Math.max(chartLeftEdge + 8, preferredLeft, 8);
    setPos({ top: r.bottom + 6, left: safeLeft });
  }, [anchorRef, width]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      const menu = document.getElementById('gov-org-portal-menu');
      if (menu?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, anchorRef, onClose]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      id="gov-org-portal-menu"
      className="org-chart-theme-menu"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width, maxHeight: '80vh', overflowY: 'auto', zIndex: 10000 }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── Org chart v3 ──────────────────────────────────────────────────────────
// Production-grade interactive tree with:
//   1. **Auto-build** from employees + employees.manager_id (per-org)
//   2. **Full-screen mode** (overlay covers the whole viewport)
//   3. **Theme picker** — Modern / Glass / Flat / Corporate
//   4. **Drag-to-reparent** — drag any node onto another to change reporting.
//      Updates employees.manager_id in the DB. Reverse flow: any chart edit
//      cascades to every consumer of that field (managers page, etc.).
//
// Pillars are a separate optional overlay tab in the governance page.

export interface OrgChartEmployee {
  id: string;
  full_name: string;
  designation: string | null;
  manager_id: string | null;
  department_id: string | null;
  status: string | null;
  is_founder?: boolean;
}
export interface OrgChartDepartment { id: string; name: string; color?: string | null; }

interface Props {
  employees: OrgChartEmployee[];
  departments: OrgChartDepartment[];
  orgName?: string | null;
  canEdit?: boolean;
  onEmployeeMoved?: () => void;             // call parent's reload after manager_id changes
  onNodeClick?: (employeeId: string) => void;
}

// ── Theme + Layout + Avatar system ────────────────────────────────────────
// All settings persist per-customer in localStorage under `gov_org_*` keys,
// so the chart opens with the customer's pinned design every time.

type ThemeKey = 'modern' | 'glass' | 'flat' | 'corporate';
const THEME_OPTIONS: { key: ThemeKey; label: string; icon: string; desc: string }[] = [
  { key: 'modern',    label: 'Modern',    icon: 'ri-magic-line',       desc: '3D gradient cards · animated edges (default)' },
  { key: 'glass',     label: 'Glassmorphic', icon: 'ri-glasses-2-line', desc: 'Frosted glass · subtle blur · soft glow' },
  { key: 'flat',      label: 'Flat',      icon: 'ri-square-line',      desc: 'Minimal · solid colors · no shadows' },
  { key: 'corporate', label: 'Corporate', icon: 'ri-building-line',    desc: 'Clean white · navy edges · printable' },
];

type LayoutKey = 'vertical' | 'horizontal' | 'compact' | 'spread' | 'radial';
const LAYOUT_OPTIONS: { key: LayoutKey; label: string; icon: string; desc: string }[] = [
  { key: 'vertical',   label: 'Vertical',   icon: 'ri-node-tree',          desc: 'Top-down tree · CEO at top (default)' },
  { key: 'horizontal', label: 'Horizontal', icon: 'ri-arrow-right-line',   desc: 'Left-to-right · CEO on the left' },
  { key: 'compact',    label: 'Compact',    icon: 'ri-layout-grid-line',   desc: 'Tight spacing · fits more on screen' },
  { key: 'spread',     label: 'Spread',     icon: 'ri-expand-width-line',  desc: 'Generous spacing · easier to read' },
  { key: 'radial',     label: 'Radial',     icon: 'ri-loader-2-line',      desc: 'Concentric rings · CEO at centre' },
];

interface ThemeStyles {
  canvasBg: string;
  cardBg: (palette: PaletteEntry) => string;
  cardBorder: (palette: PaletteEntry) => string;
  cardText: (palette: PaletteEntry) => string;
  cardShadow: string;
  cardHoverShadow: string;
  edgeAnimated: boolean;
  edgeStrokeColor: (palette: PaletteEntry) => string;
  edgeWidth: number;
  dotGridColor: string;
  variant: BackgroundVariant;
}

interface PaletteEntry { name: string; bg: string; gradBg: string; border: string; text: string; glow: string; }

const PALETTE: PaletteEntry[] = [
  { name: 'amber',    bg: '#fff8e6', gradBg: 'linear-gradient(135deg, #fff5e6 0%, #ffeacc 100%)', border: '#d4a020', text: '#5b3d00', glow: 'rgba(212, 160, 32, 0.4)' },
  { name: 'blue',     bg: '#e8f0fe', gradBg: 'linear-gradient(135deg, #e8f0fe 0%, #d0e0fb 100%)', border: '#2563a8', text: '#0f3a6e', glow: 'rgba(37, 99, 168, 0.4)' },
  { name: 'green',    bg: '#e8f5ef', gradBg: 'linear-gradient(135deg, #e8f5ef 0%, #cfe9dc 100%)', border: '#176044', text: '#0b3d28', glow: 'rgba(23, 96, 68, 0.4)' },
  { name: 'orange',   bg: '#fdf3e2', gradBg: 'linear-gradient(135deg, #fdf3e2 0%, #fae6c0 100%)', border: '#c87b14', text: '#7a5500', glow: 'rgba(200, 123, 20, 0.4)' },
  { name: 'purple',   bg: '#f1eeff', gradBg: 'linear-gradient(135deg, #f1eeff 0%, #e3dcfd 100%)', border: '#5535a0', text: '#2e1a5c', glow: 'rgba(85, 53, 160, 0.4)' },
  { name: 'red',      bg: '#fdf0f0', gradBg: 'linear-gradient(135deg, #fdf0f0 0%, #fadada 100%)', border: '#8f1f1f', text: '#5a1010', glow: 'rgba(143, 31, 31, 0.4)' },
  { name: 'teal',     bg: '#e8f5f7', gradBg: 'linear-gradient(135deg, #e8f5f7 0%, #cce8ed 100%)', border: '#155e6b', text: '#0a3b44', glow: 'rgba(21, 94, 107, 0.4)' },
  { name: 'magenta',  bg: '#f5f0ff', gradBg: 'linear-gradient(135deg, #f5f0ff 0%, #ebe0fa 100%)', border: '#7a3f8c', text: '#3d2046', glow: 'rgba(122, 63, 140, 0.4)' },
  { name: 'gray',     bg: '#f0ede8', gradBg: 'linear-gradient(135deg, #f0ede8 0%, #e1ddd4 100%)', border: '#666666', text: '#333333', glow: 'rgba(102, 102, 102, 0.4)' },
];

const FOUNDER_PALETTE: PaletteEntry = {
  name: 'founder', bg: '#fbe8a6',
  gradBg: 'linear-gradient(135deg, #fbe8a6 0%, #f4c948 100%)',
  border: '#b88a14', text: '#3d2900', glow: 'rgba(184, 138, 20, 0.6)',
};

function colorForDept(deptName: string | undefined | null, deptId: string | null): PaletteEntry {
  const key = deptName ?? deptId ?? 'unknown';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const THEMES: Record<ThemeKey, ThemeStyles> = {
  modern: {
    canvasBg: 'linear-gradient(135deg, #0a0f1c 0%, #0d1426 50%, #0a0f1c 100%)',
    cardBg: (p) => p.gradBg,
    cardBorder: (p) => p.border,
    cardText: (p) => p.text,
    cardShadow: '0 4px 6px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.6)',
    cardHoverShadow: '0 12px 24px rgba(0,0,0,0.25), 0 4px 8px rgba(0,0,0,0.15), 0 0 24px var(--node-glow), inset 0 1px 0 rgba(255,255,255,0.7)',
    edgeAnimated: true,
    edgeStrokeColor: (p) => p.border,
    edgeWidth: 2,
    dotGridColor: 'rgba(255,255,255,0.08)',
    variant: BackgroundVariant.Dots,
  },
  glass: {
    canvasBg: 'radial-gradient(circle at top, #1e293b 0%, #0f172a 100%)',
    cardBg: (p) => `rgba(255,255,255,0.08)`,
    cardBorder: (p) => p.border,
    cardText: () => '#f1f5f9',
    cardShadow: '0 8px 32px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.1)',
    cardHoverShadow: '0 16px 48px rgba(0,0,0,0.4), 0 0 32px var(--node-glow), inset 0 1px 0 rgba(255,255,255,0.2)',
    edgeAnimated: true,
    edgeStrokeColor: (p) => p.border,
    edgeWidth: 1.5,
    dotGridColor: 'rgba(255,255,255,0.05)',
    variant: BackgroundVariant.Dots,
  },
  flat: {
    canvasBg: '#f8fafc',
    cardBg: (p) => p.bg,
    cardBorder: (p) => p.border,
    cardText: (p) => p.text,
    cardShadow: 'none',
    cardHoverShadow: '0 2px 8px rgba(0,0,0,0.08)',
    edgeAnimated: false,
    edgeStrokeColor: () => '#94a3b8',
    edgeWidth: 1.5,
    dotGridColor: '#e2e8f0',
    variant: BackgroundVariant.Lines,
  },
  corporate: {
    canvasBg: '#ffffff',
    cardBg: () => '#ffffff',
    cardBorder: (p) => p.border,
    cardText: (p) => p.text,
    cardShadow: '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
    cardHoverShadow: '0 4px 12px rgba(15,23,42,0.10), 0 0 0 3px var(--node-glow)',
    edgeAnimated: false,
    edgeStrokeColor: () => '#1e293b',
    edgeWidth: 1.5,
    dotGridColor: '#e2e8f0',
    variant: BackgroundVariant.Lines,
  },
};

// ── Custom node ───────────────────────────────────────────────────────────

type EmployeeNodeData = {
  name: string;
  title: string;
  palette: PaletteEntry;
  isRoot: boolean;
  isFounder: boolean;
  childCount: number;
  theme: ThemeKey;
  showAvatar: boolean;
  layout: LayoutKey;
  bgIsLight: boolean;          // auto-flips card text for high contrast
  avatarStyle: AvatarStyle;    // DiceBear style or 'initials' for the monogram
  avatarSeed: string;          // effective seed (may be overridden per-employee)
  canEdit: boolean;            // show the per-card edit pencil icon
};

// Per-employee avatar overrides — keyed by employee.id, stored in
// localStorage so the customer's customizations survive reloads.
// { style?: override, seed?: custom seed string }
type AvatarOverride = { style?: AvatarStyle; seed?: string };
const AVATAR_OVERRIDES_KEY = 'gov_org_avatar_overrides_v1';

function readOverrides(): Record<string, AvatarOverride> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(AVATAR_OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AvatarOverride>) : {};
  } catch { return {}; }
}
function writeOverrides(map: Record<string, AvatarOverride>) {
  try { localStorage.setItem(AVATAR_OVERRIDES_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// Initials derived from the full name. Handles 1, 2, or 3+ words.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Darken a hex color by a factor 0..1 (1 = black). Used to give the avatar
// gradient depth.
function darken(hex: string, amount: number): string {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return hex;
  const [r, g, b] = m.map((x) => parseInt(x, 16));
  const f = Math.max(0, 1 - amount);
  return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
}

// Standard W3C relative luminance — 0 = pure black, 1 = pure white.
// Used to auto-flip card text + edge colors so a light custom background
// (e.g. pink, beige) doesn't make the chart unreadable.
function relativeLuminance(hex: string): number {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return 0;
  const [r, g, b] = m.map((x) => parseInt(x, 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Each preset's effective brightness. Most animated presets are dark; only
// 'custom' inherits the user's solid color.
function backgroundLuminance(bg: BackgroundKey, customColor: string): number {
  if (bg === 'custom') return relativeLuminance(customColor);
  return 0.05;        // all other presets sit on a dark navy base
}

function EmployeeNode({ data, selected, id }: NodeProps<Node<EmployeeNodeData>>) {
  const { name, title, palette, isRoot, isFounder, childCount, theme, showAvatar, layout, bgIsLight, avatarStyle, avatarSeed, canEdit } = data;
  const t = THEMES[theme];
  const pal = isFounder ? FOUNDER_PALETTE : palette;
  const handlePosTarget = layout === 'horizontal' ? Position.Left  : Position.Top;
  const handlePosSource = layout === 'horizontal' ? Position.Right : Position.Bottom;

  // When the canvas background is light (user chose Solid → pink/beige/etc.)
  // override the card text color to a deep contrast hue derived from the
  // palette — readable on the card AND on the surrounding light canvas.
  // Also force a strong card border so the card silhouette pops.
  const effectiveText   = bgIsLight ? darken(pal.border, 0.55) : t.cardText(pal);
  const effectiveBorder = bgIsLight ? darken(pal.border, 0.15) : t.cardBorder(pal);
  // On Modern/Glass themes the gradient card BG is already light enough; on
  // Glass + light canvas we lose contrast badly — swap to solid pastel.
  const effectiveBg     = (bgIsLight && (theme === 'glass' || theme === 'modern'))
    ? pal.bg
    : t.cardBg(pal);

  return (
    <div
      className={`org-node org-node--${theme} ${selected ? 'org-node--selected' : ''} ${isFounder ? 'org-node--founder' : ''} ${showAvatar ? 'org-node--with-avatar' : ''}`}
      style={{
        background: effectiveBg,
        borderColor: effectiveBorder,
        color: effectiveText,
        boxShadow: bgIsLight
          ? '0 4px 12px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.6)'
          : t.cardShadow,
        ['--node-border' as string]: effectiveBorder,
        ['--node-glow'   as string]: pal.glow,
        ['--hover-shadow' as string]: t.cardHoverShadow,
      }}
    >
      <Handle type="target" position={handlePosTarget} className="org-handle" style={{ background: t.cardBorder(pal) }} />
      {isFounder && <div className="org-node__crown">👑</div>}
      {showAvatar && (
        <div
          className="org-avatar"
          style={{
            // Monogram fallback styling — only visible when avatarStyle ==
            // 'initials'. DiceBear styles get rendered as an <img> inside
            // and the background gradient is hidden by the img itself.
            background: avatarStyle === 'initials'
              ? `radial-gradient(circle at 30% 30%, ${pal.border}, ${darken(pal.border, 0.35)})`
              : '#0f172a',     // a dark backdrop while the SVG loads
            color: '#ffffff',
            borderColor: theme === 'corporate' || theme === 'flat' ? '#ffffff' : 'rgba(255,255,255,0.92)',
            boxShadow: `0 4px 14px ${pal.glow}, inset 0 2px 0 rgba(255,255,255,0.25), inset 0 -2px 0 rgba(0,0,0,0.15)`,
            overflow: 'hidden',
          }}
          aria-label={`Avatar for ${name}`}
        >
          {avatarStyle === 'initials' ? (
            <span className="org-avatar__text">{initialsOf(name)}</span>
          ) : (
            <Avatar
              seed={avatarSeed}
              style={avatarStyle}
              size={isFounder ? 54 : 48}
              backgroundColor={[pal.border.replace('#', ''), darken(pal.border, 0.25).replace('rgb(', '').replace(')', '')]}
            />
          )}
          <span className="org-avatar__ring" style={{ borderColor: pal.border }} />
        </div>
      )}
      <div className="org-node__name">{name}</div>
      {title && <div className="org-node__title">{title}</div>}
      {(isRoot || childCount > 0) && (
        <div className="org-node__meta">
          {isRoot && <span className="org-node__chip org-node__chip--root">ROOT</span>}
          {childCount > 0 && (
            <span className="org-node__chip">
              <i className="ri-team-line" /> {childCount}
            </span>
          )}
        </div>
      )}
      {canEdit && (
        <button
          type="button"
          className="org-node__edit"
          title="Customize this card"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('gov-org-customize', { detail: { employeeId: id, name } }));
          }}
          aria-label={`Customize ${name}`}
        >
          <i className="ri-pencil-fill" />
        </button>
      )}
      <Handle type="source" position={handlePosSource} className="org-handle" style={{ background: t.cardBorder(pal) }} />
    </div>
  );
}

const nodeTypes = { employee: EmployeeNode };

// Layout engines. dagre handles tree variants; radial uses a manual polar
// algorithm where each tree level is a concentric ring around the root.

interface LayoutConfig {
  rankdir: 'TB' | 'LR';
  nodesep: number;
  ranksep: number;
}
const LAYOUT_CONFIG: Record<Exclude<LayoutKey, 'radial'>, LayoutConfig> = {
  vertical:   { rankdir: 'TB', nodesep: 40, ranksep: 80  },
  horizontal: { rankdir: 'LR', nodesep: 28, ranksep: 110 },
  compact:    { rankdir: 'TB', nodesep: 20, ranksep: 45  },
  spread:     { rankdir: 'TB', nodesep: 80, ranksep: 140 },
};

function layoutNodes(nodes: Node[], edges: Edge[], layout: LayoutKey, withAvatar: boolean) {
  // Card size depends on whether avatars are rendered. With-avatar adds
  // 48px circle + 6px gap on top of the regular card body.
  const W = withAvatar ? 240 : 220;
  const H = withAvatar ? 150 : 100;

  if (layout === 'radial') return radialLayout(nodes, edges, W, H);

  const cfg = LAYOUT_CONFIG[layout];
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: cfg.rankdir, nodesep: cfg.nodesep, ranksep: cfg.ranksep, marginx: 30, marginy: 30 });
  nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - W / 2, y: pos.y - H / 2 } };
  });
}

// Radial layout: place root at origin (0,0); compute depth of each node via
// BFS from roots; arrange each depth level on a concentric circle, spaced
// angularly proportional to subtree size. Works well for ≤50 nodes.
function radialLayout(nodes: Node[], edges: Edge[], W: number, H: number) {
  if (nodes.length === 0) return nodes;
  // Build adjacency: parent → children, child → parent.
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const e of edges) {
    const arr = children.get(e.source) ?? [];
    arr.push(e.target);
    children.set(e.source, arr);
    parent.set(e.target, e.source);
  }
  // Roots = nodes with no parent edge.
  const roots = nodes.filter((n) => !parent.has(n.id)).map((n) => n.id);
  if (roots.length === 0) return nodes;        // safety

  // If multiple roots, pretend there's a virtual super-root above.
  const RADIUS_STEP = 220;
  const positions = new Map<string, { x: number; y: number }>();

  // Subtree leaf count drives angular weight.
  const leafCount = new Map<string, number>();
  function countLeaves(id: string): number {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) { leafCount.set(id, 1); return 1; }
    let s = 0;
    for (const k of kids) s += countLeaves(k);
    leafCount.set(id, s);
    return s;
  }
  for (const r of roots) countLeaves(r);

  // Place each subtree in its angular sector.
  function place(id: string, depth: number, angleStart: number, angleEnd: number) {
    const mid = (angleStart + angleEnd) / 2;
    const r = depth * RADIUS_STEP;
    positions.set(id, {
      x: r * Math.cos(mid) - W / 2,
      y: r * Math.sin(mid) - H / 2,
    });
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const total = leafCount.get(id) ?? 1;
    let a = angleStart;
    for (const k of kids) {
      const w = (leafCount.get(k) ?? 1) / total;
      const sweep = (angleEnd - angleStart) * w;
      place(k, depth + 1, a, a + sweep);
      a += sweep;
    }
  }

  const totalLeaves = roots.reduce((s, r) => s + (leafCount.get(r) ?? 1), 0);
  let a = -Math.PI / 2;          // start at top
  const sweepAll = 2 * Math.PI;
  for (const r of roots) {
    const w = (leafCount.get(r) ?? 1) / totalLeaves;
    const sweep = sweepAll * w;
    place(r, roots.length === 1 ? 0 : 1, a, a + sweep);
    a += sweep;
  }

  return nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } }));
}

// Detects whether `descendant` is below `ancestor` in the manager chain.
// Used to prevent creating a cycle when the user drag-reparents.
function isDescendantOf(
  descendant: string,
  ancestor: string,
  parentMap: Map<string, string | null>,
): boolean {
  let cur: string | null | undefined = descendant;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return false;       // safety: existing cycle
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parentMap.get(cur) ?? null;
  }
  return false;
}

// ── Main component ────────────────────────────────────────────────────────

// Wrap with provider so the inner component can use `useReactFlow()` to call
// fitView() programmatically (needed when layout / theme / avatar changes).
export default function OrgChart(props: Props) {
  return (
    <ReactFlowProvider>
      <OrgChartInner {...props} />
    </ReactFlowProvider>
  );
}

function OrgChartInner({
  employees, departments, orgName, canEdit = false, onEmployeeMoved, onNodeClick,
}: Props) {
  // ALL chart preferences persist per-customer in localStorage. They form
  // the "pinned design" that loads automatically on every visit.
  const readPref = <T extends string>(key: string, fallback: T): T => {
    if (typeof window === 'undefined') return fallback;
    return (localStorage.getItem(key) as T) ?? fallback;
  };
  const readBool = (key: string, fallback: boolean): boolean => {
    if (typeof window === 'undefined') return fallback;
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v !== 'false';
  };

  const [theme,          setTheme]          = useState<ThemeKey>(     () => readPref('gov_org_theme',  'modern'));
  const [layout,         setLayout]         = useState<LayoutKey>(    () => readPref('gov_org_layout', 'vertical'));
  const [showAvatar,     setShowAvatar]     = useState<boolean>(      () => readBool('gov_org_avatar', true));
  const [hideUnassigned, setHideUnassigned] = useState<boolean>(      () => readBool('gov_org_hide_unassigned', true));
  const [background,     setBackground]     = useState<BackgroundKey>(() => readPref('gov_org_bg',     'default'));
  const [customBgColor,  setCustomBgColor]  = useState<string>(       () => readPref('gov_org_bg_color', '#0a0f1c'));
  const [accentColor,    setAccentColor]    = useState<string>(       () => readPref('gov_org_accent', '#34d399'));
  const [avatarStyle,    setAvatarStyle]    = useState<AvatarStyle>(  () => readPref('gov_org_avatar_style', 'personas'));
  const [overrides,      setOverrides]      = useState<Record<string, AvatarOverride>>(() => readOverrides());
  const [customizingEmp, setCustomizingEmp] = useState<{ id: string; name: string } | null>(null);

  // Listen for "customize" events fired from node pencil buttons.
  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ employeeId: string; name: string }>).detail;
      if (detail?.employeeId) setCustomizingEmp({ id: detail.employeeId, name: detail.name });
    };
    window.addEventListener('gov-org-customize', onCustom);
    return () => window.removeEventListener('gov-org-customize', onCustom);
  }, []);

  const saveOverride = useCallback((employeeId: string, patch: AvatarOverride | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (patch === null || (!patch.style && !patch.seed)) delete next[employeeId];
      else next[employeeId] = { ...next[employeeId], ...patch };
      writeOverrides(next);
      return next;
    });
  }, []);
  const [fullscreen,     setFullscreen]     = useState(false);
  const [pendingMove,    setPendingMove]    = useState<{ child: OrgChartEmployee; newParent: OrgChartEmployee | null } | null>(null);
  const [saving,         setSaving]         = useState(false);

  // Persist every preference change.
  useEffect(() => { try { localStorage.setItem('gov_org_theme', theme); } catch { /* ignore */ } }, [theme]);
  useEffect(() => { try { localStorage.setItem('gov_org_layout', layout); } catch { /* ignore */ } }, [layout]);
  useEffect(() => { try { localStorage.setItem('gov_org_avatar', String(showAvatar)); } catch { /* ignore */ } }, [showAvatar]);
  useEffect(() => { try { localStorage.setItem('gov_org_hide_unassigned', String(hideUnassigned)); } catch { /* ignore */ } }, [hideUnassigned]);
  useEffect(() => { try { localStorage.setItem('gov_org_bg', background); } catch { /* ignore */ } }, [background]);
  useEffect(() => { try { localStorage.setItem('gov_org_bg_color', customBgColor); } catch { /* ignore */ } }, [customBgColor]);
  useEffect(() => { try { localStorage.setItem('gov_org_accent', accentColor); } catch { /* ignore */ } }, [accentColor]);
  useEffect(() => { try { localStorage.setItem('gov_org_avatar_style', avatarStyle); } catch { /* ignore */ } }, [avatarStyle]);

  // Auto-fit handle from react-flow — used to call fitView programmatically
  // after layouts/theme/avatar changes so the chart always fills the canvas
  // properly instead of staying tiny in the corner.
  const { fitView } = useReactFlow();
  const refitTimer = useRef<number | null>(null);
  const scheduleRefit = useCallback(() => {
    if (refitTimer.current) window.clearTimeout(refitTimer.current);
    refitTimer.current = window.setTimeout(() => {
      try { fitView({ padding: 0.15, duration: 500, maxZoom: 1.1, minZoom: 0.05 }); } catch { /* ignore */ }
    }, 80);
  }, [fitView]);

  // Esc closes fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const deptById = useMemo(() => {
    const m = new Map<string, OrgChartDepartment>();
    for (const d of departments) m.set(d.id, d);
    return m;
  }, [departments]);

  // Strict "active only" filter — excludes every status that isn't actively
  // working. This also drops 'offboarding' (mid-process) so the chart never
  // shows people who are on their way out. Null/undefined status (legacy
  // rows) is treated as active.
  const INACTIVE_STATUSES = new Set(['offboarding', 'offboarded', 'disabled', 'terminated', 'inactive', 'suspended']);
  const allActive = useMemo(
    () => employees.filter((e) => !e.status || !INACTIVE_STATUSES.has(e.status.toLowerCase())),
    [employees],
  );

  // "Unassigned" = active employee with NO manager AND NO direct reports
  // AND not the founder. Top-level executives (COO/CTO/etc. who manage
  // others but report to nobody in DB) used to get incorrectly flagged as
  // unassigned — fixed by requiring them to also have zero direct reports
  // before treating them as orphans.
  const reportsCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of allActive) {
      if (e.manager_id) m.set(e.manager_id, (m.get(e.manager_id) ?? 0) + 1);
    }
    return m;
  }, [allActive]);

  const unassignedIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of allActive) {
      const hasReports = (reportsCountMap.get(e.id) ?? 0) > 0;
      if (!e.manager_id && !e.is_founder && !hasReports) s.add(e.id);
    }
    return s;
  }, [allActive, reportsCountMap]);

  const activeEmployees = useMemo(() => (
    hideUnassigned ? allActive.filter((e) => !unassignedIds.has(e.id)) : allActive
  ), [allActive, unassignedIds, hideUnassigned]);

  const unassignedList = useMemo(
    () => allActive.filter((e) => unassignedIds.has(e.id)),
    [allActive, unassignedIds],
  );

  const empById = useMemo(() => {
    const m = new Map<string, OrgChartEmployee>();
    for (const e of activeEmployees) m.set(e.id, e);
    return m;
  }, [activeEmployees]);

  const parentMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const e of activeEmployees) m.set(e.id, e.manager_id ?? null);
    return m;
  }, [activeEmployees]);

  const childCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of activeEmployees) {
      if (e.manager_id) m.set(e.manager_id, (m.get(e.manager_id) ?? 0) + 1);
    }
    return m;
  }, [activeEmployees]);

  // Auto-readability: detect when the canvas is light (custom solid color)
  // and propagate the flag to nodes + edges so they swap to dark text /
  // dark edges. Re-derived every render.
  const bgLum = backgroundLuminance(background, customBgColor);
  const bgIsLight = bgLum > 0.55;

  const { initialNodes, initialEdges } = useMemo(() => {
    if (activeEmployees.length === 0) return { initialNodes: [] as Node[], initialEdges: [] as Edge[] };
    const idSet = new Set(activeEmployees.map((e) => e.id));
    const t = THEMES[theme];

    // Find the founder so we can auto-attach top-level executives (people
    // with no manager but who DO manage others — e.g. COO Upasana Kapur).
    const founderId = activeEmployees.find((e) => e.is_founder)?.id ?? null;

    const nodes: Node[] = activeEmployees.map((e) => {
      const dept = e.department_id ? deptById.get(e.department_id) : null;
      const palette = colorForDept(dept?.name, e.department_id);
      const isRoot = !!e.is_founder;
      const override = overrides[e.id] ?? {};
      const effectiveStyle = override.style ?? avatarStyle;
      const effectiveSeed  = override.seed  ?? e.full_name;
      return {
        id: e.id,
        type: 'employee',
        position: { x: 0, y: 0 },
        data: {
          name: e.full_name,
          title: e.designation ?? (e.is_founder ? 'CEO · Owner' : ''),
          palette,
          isRoot,
          isFounder: !!e.is_founder,
          childCount: childCountMap.get(e.id) ?? 0,
          theme,
          showAvatar,
          layout,
          bgIsLight,
          avatarStyle: effectiveStyle,
          avatarSeed: effectiveSeed,
          canEdit,
        } satisfies EmployeeNodeData,
      };
    });

    const edges: Edge[] = [];
    for (const e of activeEmployees) {
      // Direct manager edge: real reporting line from DB.
      let parentId: string | null = null;
      if (e.manager_id && idSet.has(e.manager_id)) {
        parentId = e.manager_id;
      } else if (
        // Auto-attach top-level executive to the founder. Criteria:
        //   1. they have no manager_id
        //   2. they are not themselves the founder
        //   3. they manage at least one other employee
        //   4. there IS a founder in the chart
        founderId &&
        e.id !== founderId &&
        !e.manager_id &&
        (reportsCountMap.get(e.id) ?? 0) > 0
      ) {
        parentId = founderId;
      }
      if (parentId) {
        const dept = e.department_id ? deptById.get(e.department_id) : null;
        const palette = colorForDept(dept?.name, e.department_id);
        const stroke = bgIsLight ? darken(palette.border, 0.35) : t.edgeStrokeColor(palette);
        const isImplicit = parentId !== e.manager_id;     // synthesized edge
        edges.push({
          id: `e-${parentId}-${e.id}`,
          source: parentId,
          target: e.id,
          type: 'smoothstep',
          animated: t.edgeAnimated && !isImplicit,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
          style: {
            stroke,
            strokeWidth: bgIsLight ? 2.5 : t.edgeWidth,
            opacity: isImplicit ? 0.4 : (bgIsLight ? 0.9 : 0.75),
            strokeDasharray: isImplicit ? '4 4' : undefined,
          },
        });
      }
    }
    return { initialNodes: nodes, initialEdges: edges };
  }, [activeEmployees, deptById, childCountMap, theme, showAvatar, layout, bgIsLight, avatarStyle, overrides, canEdit]);

  const laidOut = useMemo(
    () => layoutNodes(initialNodes, initialEdges, layout, showAvatar),
    [initialNodes, initialEdges, layout, showAvatar],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(laidOut);
  const [edges, _setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => { setNodes(laidOut); scheduleRefit(); }, [laidOut, setNodes, scheduleRefit]);
  // Also refit when fullscreen toggles (canvas size changed).
  useEffect(() => { scheduleRefit(); }, [fullscreen, scheduleRefit]);

  const handleNodeClick = useCallback((_evt: unknown, node: Node) => {
    onNodeClick?.(node.id);
  }, [onNodeClick]);

  // ── DRAG-TO-REPARENT ──
  // When the user drops a node, react-flow runs onNodeDragStop. We figure out
  // which node it overlaps and propose a manager change. Safety:
  //  • can't drop on self
  //  • can't drop on a descendant (would create cycle)
  //  • requires canEdit
  const handleNodeDragStop = useCallback((_evt: React.MouseEvent, node: Node) => {
    if (!canEdit) {
      // Snap back — revert to laid-out position.
      setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, position: laidOut.find((l: Node) => l.id === n.id)?.position ?? n.position } : n));
      return;
    }
    // Find overlapping node (the one whose centre is closest if within 100px of dropped node).
    const drop = node.position;
    let best: { id: string; dist: number } | null = null;
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const dx = (other.position.x + 110) - (drop.x + 110);
      const dy = (other.position.y + 50)  - (drop.y + 50);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 130 && (!best || d < best.dist)) best = { id: other.id, dist: d };
    }

    const child = empById.get(node.id);
    if (!child) return;

    const newParentId = best?.id ?? null;       // null = drop on empty canvas → make root
    // No-op?
    if ((child.manager_id ?? null) === newParentId) {
      // Restore layout position.
      setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, position: laidOut.find((l: Node) => l.id === n.id)?.position ?? n.position } : n));
      return;
    }
    // Cycle check.
    if (newParentId && isDescendantOf(newParentId, child.id, parentMap)) {
      notify.success('Cannot drop this person under their own report — would create a cycle.');
      setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, position: laidOut.find((l: Node) => l.id === n.id)?.position ?? n.position } : n));
      return;
    }
    const newParent = newParentId ? (empById.get(newParentId) ?? null) : null;
    setPendingMove({ child, newParent });
    // Snap back visually until confirmed.
    setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, position: laidOut.find((l) => l.id === n.id)?.position ?? n.position } : n));
  }, [canEdit, nodes, empById, parentMap, laidOut, setNodes]);

  const confirmMove = useCallback(async () => {
    if (!pendingMove) return;
    setSaving(true);
    const { child, newParent } = pendingMove;
    // Direct RLS-protected update — employees table policies already allow
    // org owner/admin/manager to UPDATE employees rows.
    const { error } = await supabase
      .from('employees')
      .update({ manager_id: newParent?.id ?? null })
      .eq('id', child.id);
    setSaving(false);
    if (error) {
      notify.error('Failed to update manager', { description: String(error.message) });
      return;
    }
    setPendingMove(null);
    onEmployeeMoved?.();
  }, [pendingMove, onEmployeeMoved]);

  const [autoLayouts, setAutoLayouts] = useState(0);
  const resetLayout = useCallback(() => {
    setNodes(layoutNodes(initialNodes, initialEdges, layout, showAvatar));
    setAutoLayouts((n) => n + 1);
  }, [initialNodes, initialEdges, layout, showAvatar, setNodes]);

  const t = THEMES[theme];

  const containerStyle = fullscreen
    ? { position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0, height: '100vh', zIndex: 50, borderRadius: 0 }
    : { height: 720 };

  // Quick action handlers for the unassigned-employees panel.
  const setEmployeeManager = useCallback(async (childId: string, managerId: string | null) => {
    const { error } = await supabase.from('employees').update({ manager_id: managerId }).eq('id', childId);
    if (error) { notify.error('Failed', { description: String(error.message) }); return; }
    onEmployeeMoved?.();
  }, [onEmployeeMoved]);

  const offboardEmployee = useCallback(async (id: string, name: string) => {
    if (!await confirmDialog({ title: `Mark ${name} as offboarded? They'll disappear from the chart and active employee lists.`, tone: 'danger' })) return;
    const { error } = await supabase.from('employees').update({ status: 'offboarded' }).eq('id', id);
    if (error) { notify.error('Failed', { description: String(error.message) }); return; }
    onEmployeeMoved?.();
  }, [onEmployeeMoved]);

  // Hard-delete an employee row — for cases where the person was never
  // really in the org (stale M365 import, test account, duplicate, etc.).
  const deleteEmployee = useCallback(async (id: string, name: string) => {
    if (!await confirmDialog({ title: `Permanently DELETE ${name} from the org?\n\nThis removes them everywhere — chart, employees list, group memberships. Cannot be undone.`, tone: 'danger' })) return;
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) { notify.error('Failed', { description: String(error.message) }); return; }
    onEmployeeMoved?.();
  }, [onEmployeeMoved]);

  // Empty-state early return AFTER every hook above. React requires the same
  // hooks to run in the same order on every render; this component mounts empty
  // and then re-renders once employees load, so an early return placed above
  // any hook changed the hook count between those two renders and crashed the
  // whole page with "Rendered more hooks than during the previous render".
  if (activeEmployees.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-10 text-center text-sm text-gray-500">
        No employees yet — add employees (with managers) at <Link to="/employees" className="text-emerald-400 hover:underline">/employees</Link> and the chart will populate automatically.
      </div>
    );
  }

  return (
    <>
      <style>{ORG_CHART_CSS}</style>
      <div
        className="org-chart-wrap"
        style={{ background: background === 'default' ? t.canvasBg : 'transparent', ...containerStyle }}
      >
        {/* Animated background layer — sits behind react-flow */}
        <AnimatedBackground preset={background} customColor={customBgColor} accent={accentColor} />

        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onNodeDragStop={handleNodeDragStop}
          nodesDraggable={canEdit}
          fitView
          // Initial fit lands at a readable zoom (12% padding, cap 1.1×).
          // The manual zoom range is intentionally WIDE — 0.05× to 3× —
          // so the customer can shrink the whole org to a thumbnail or
          // pan in close enough to read individual designations.
          fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.5 }}
          minZoom={0.05}
          maxZoom={3.0}
          proOptions={{ hideAttribution: true }}
          // Remounting on key change resets the viewport so each layout
          // /theme /avatar /bg combo gets its own freshly-fit view.
          key={`${autoLayouts}-${theme}-${layout}-${showAvatar}-${background}-${bgIsLight ? 'L' : 'D'}`}
        >
          {background === 'default' && (
            <Background variant={t.variant} gap={24} size={1.5} color={t.dotGridColor} />
          )}
          <Controls position="bottom-right" className="org-chart-controls" />
          <MiniMap
            position="bottom-left"
            nodeStrokeColor={(n) => (n.data as EmployeeNodeData).palette.border}
            nodeColor={(n) => (n.data as EmployeeNodeData).palette.border}
            maskColor={bgIsLight ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)'}
            style={{
              background: bgIsLight || theme === 'corporate' || theme === 'flat' ? '#f1f5f9' : '#0f172a',
              border: `1px solid ${bgIsLight ? 'rgba(15,23,42,0.15)' : 'rgba(255,255,255,0.1)'}`,
            }}
          />

          {/* Floating toolbar */}
          <div className="org-chart-header">
            <div className="org-chart-header__title">
              <i className="ri-organization-chart" />
              <span>{orgName ?? 'Organization Chart'}</span>
            </div>
            <div className="org-chart-header__stat">
              <span className="org-chart-header__count">{activeEmployees.length}</span>
              <span className="org-chart-header__label">members</span>
            </div>
            {canEdit && (
              <span className="org-chart-header__hint" title="Drag any node onto another to change reporting">
                <i className="ri-drag-move-2-line" /> Drag to reparent
              </span>
            )}
            {unassignedList.length > 0 && (
              <button
                onClick={() => setHideUnassigned((v) => !v)}
                className="org-chart-header__btn"
                title={hideUnassigned
                  ? `Show ${unassignedList.length} employee(s) without a manager`
                  : 'Hide employees without a manager'}
              >
                <i className={hideUnassigned ? 'ri-user-unfollow-line' : 'ri-user-follow-line'} />
                {hideUnassigned ? ` ${unassignedList.length} unassigned` : ' Hide unassigned'}
              </button>
            )}
            <button
              onClick={() => setShowAvatar((v) => !v)}
              className={`org-chart-header__btn ${showAvatar ? 'org-chart-header__btn--active' : ''}`}
              title={showAvatar ? 'Hide avatars' : 'Show avatars'}
            >
              <i className={showAvatar ? 'ri-user-line' : 'ri-user-3-line'} />
              {showAvatar ? ' Avatars on' : ' Avatars off'}
            </button>
            {showAvatar && (
              <AvatarStylePicker style={avatarStyle} setStyle={setAvatarStyle} />
            )}
            <LayoutPicker layout={layout} setLayout={setLayout} />
            <ThemePicker theme={theme} setTheme={setTheme} />
            <BackgroundPicker
              background={background}
              setBackground={setBackground}
              customColor={customBgColor}
              setCustomColor={setCustomBgColor}
              accent={accentColor}
              setAccent={setAccentColor}
            />
            <button onClick={resetLayout} className="org-chart-header__btn" title="Auto-layout the tree">
              <i className="ri-magic-line" /> Layout
            </button>
            <button
              onClick={() => setFullscreen((v) => !v)}
              className="org-chart-header__btn"
              title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            >
              <i className={fullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'} />
              {fullscreen ? ' Exit' : ' Full screen'}
            </button>
          </div>
        </ReactFlow>
      </div>

      {/* Unassigned employees panel — only when hideUnassigned is on AND there are unassigned */}
      {!fullscreen && hideUnassigned && unassignedList.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm text-amber-200">
              <i className="ri-error-warning-line" />
              <strong>{unassignedList.length}</strong> employee{unassignedList.length === 1 ? '' : 's'} have no manager assigned
            </div>
            <Link to="/employees/managers" className="text-xs text-amber-300 hover:text-amber-200 underline">
              Open Managers page →
            </Link>
          </div>
          <p className="text-[11px] text-amber-200/70 mb-3">
            These employees imported from M365/Google directory without a manager_id, OR were never assigned one in Rudrans.
            They're hidden from the chart above. Assign a manager OR mark them offboarded if they're not actually in your org.
          </p>
          <div className="overflow-hidden rounded-lg border border-amber-500/20">
            <table className="w-full text-xs">
              <thead className="bg-amber-500/10">
                <tr className="text-left text-[10px] uppercase tracking-wider text-amber-300/80">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Designation</th>
                  {canEdit && <th className="px-3 py-2 w-64">Assign manager</th>}
                  {canEdit && <th className="px-3 py-2 w-20" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-500/10 bg-dark-900/40">
                {unassignedList.map((u) => (
                  <tr key={u.id} className="hover:bg-amber-500/5">
                    <td className="px-3 py-2 text-gray-200">{u.full_name}</td>
                    <td className="px-3 py-2 text-gray-400">{u.designation ?? <span className="italic text-gray-600">—</span>}</td>
                    {canEdit && (
                      <td className="px-3 py-2">
                        <select
                          defaultValue=""
                          onChange={async (e) => {
                            const v = e.target.value;
                            if (!v) return;
                            // Reset the select first: awaiting the dialog lets
                            // React pool/reuse the event, so `e.target` must not
                            // be read after the await.
                            const select = e.target;
                            if (await confirmDialog({
                              title: `Set ${u.full_name}'s manager to ${empById.get(v)?.full_name ?? v}?`,
                            })) {
                              setEmployeeManager(u.id, v);
                            } else {
                              select.value = '';
                            }
                          }}
                          className="w-full bg-dark-900 border border-dark-700 rounded px-2 py-1 text-white text-xs"
                        >
                          <option value="">Pick a manager…</option>
                          {allActive.filter((m) => m.id !== u.id).map((m) => (
                            <option key={m.id} value={m.id}>{m.full_name}{m.designation ? ` · ${m.designation}` : ''}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    {canEdit && (
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => offboardEmployee(u.id, u.full_name)}
                          className="text-[10px] text-amber-300 hover:text-amber-200 mr-3"
                          title="Mark as offboarded (keeps history)"
                        >
                          Offboard
                        </button>
                        <button
                          onClick={() => deleteEmployee(u.id, u.full_name)}
                          className="text-[10px] text-rose-400 hover:text-rose-300"
                          title="Permanently delete from DB (use when this person was never in your org)"
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Per-employee avatar customization modal */}
      {customizingEmp && (
        <EmployeeAvatarCustomizer
          employeeId={customizingEmp.id}
          name={customizingEmp.name}
          globalStyle={avatarStyle}
          current={overrides[customizingEmp.id] ?? {}}
          onChange={(patch) => saveOverride(customizingEmp.id, patch)}
          onReset={() => saveOverride(customizingEmp.id, null)}
          onDeleteEmployee={() => { deleteEmployee(customizingEmp.id, customizingEmp.name); setCustomizingEmp(null); }}
          onOffboard={() => { offboardEmployee(customizingEmp.id, customizingEmp.name); setCustomizingEmp(null); }}
          onClose={() => setCustomizingEmp(null)}
          canEdit={canEdit}
        />
      )}

      {/* Confirm manager-change modal */}
      {pendingMove && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70" onClick={() => setPendingMove(null)}>
          <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-dark-700">
              <h2 className="font-semibold text-white flex items-center gap-2">
                <i className="ri-user-shared-line text-emerald-400" />
                Change reporting line?
              </h2>
            </div>
            <div className="p-5 text-sm text-gray-300 space-y-3">
              <p>
                <strong className="text-white">{pendingMove.child.full_name}</strong> will now report to{' '}
                {pendingMove.newParent ? (
                  <strong className="text-white">{pendingMove.newParent.full_name}</strong>
                ) : (
                  <span className="text-amber-300">no one (top-level)</span>
                )}
                .
              </p>
              <p className="text-xs text-gray-500">
                This updates <code className="text-emerald-400">employees.manager_id</code> — every page using it
                (managers, governance, org chart) will reflect this immediately.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
              <button onClick={() => setPendingMove(null)} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
              <button
                onClick={confirmMove}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Confirm move'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Per-employee avatar customizer modal. Opens from the pencil icon on each
// card. Lets the customer:
//   • Pick a DIFFERENT DiceBear style for just this person
//   • Use a custom seed (regenerates the look in the same style)
//   • Reset back to the global default
//   • Quick-action: Offboard or Delete this employee
function EmployeeAvatarCustomizer({
  employeeId, name, globalStyle, current,
  onChange, onReset, onDeleteEmployee, onOffboard, onClose, canEdit,
}: {
  employeeId: string;
  name: string;
  globalStyle: AvatarStyle;
  current: AvatarOverride;
  onChange: (patch: AvatarOverride) => void;
  onReset: () => void;
  onDeleteEmployee: () => void;
  onOffboard: () => void;
  onClose: () => void;
  canEdit: boolean;
}) {
  const effectiveStyle = current.style ?? globalStyle;
  const effectiveSeed  = current.seed  ?? name;
  const [customSeed, setCustomSeed] = useState(current.seed ?? '');
  const [seedDirty, setSeedDirty] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-dark-700 flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-white flex items-center gap-2">
              <i className="ri-user-settings-line text-emerald-400" />
              Customize avatar — {name}
            </h2>
            <p className="text-xs text-gray-500 mt-1">Changes save automatically. Other employees aren't affected.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          {/* Live preview */}
          <div className="flex items-center justify-center">
            <div style={{ width: 110, height: 110, borderRadius: '50%', overflow: 'hidden', background: '#0f172a', border: '3px solid rgba(255,255,255,0.1)' }}>
              {effectiveStyle === 'initials' ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#34d399', color: '#0a0f1c', fontWeight: 700, fontSize: 36 }}>
                  {initialsOf(effectiveSeed)}
                </div>
              ) : (
                <Avatar seed={effectiveSeed} style={effectiveStyle} size={110} />
              )}
            </div>
          </div>

          {/* Style picker */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-2">Avatar style for this person</label>
            <div className="grid grid-cols-3 gap-2">
              {AVATAR_STYLE_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => onChange({ style: o.key === globalStyle && !current.seed ? undefined : o.key })}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition ${
                    effectiveStyle === o.key
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-dark-700 bg-dark-900 hover:border-dark-600'
                  }`}
                  title={o.desc}
                >
                  <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', background: '#0f172a' }}>
                    {o.key === 'initials' ? (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#34d399', color: '#0a0f1c', fontWeight: 700, fontSize: 14 }}>
                        {initialsOf(effectiveSeed)}
                      </div>
                    ) : (
                      <Avatar seed={effectiveSeed} style={o.key} size={40} />
                    )}
                  </div>
                  <span className="text-[10px] text-gray-300">{o.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom seed (regenerates look within style) */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Variation seed (don't like the face? type any text to reroll)
            </label>
            <div className="flex items-center gap-2">
              <input
                value={customSeed}
                onChange={(e) => { setCustomSeed(e.target.value); setSeedDirty(true); }}
                placeholder={name}
                className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm"
              />
              <button
                disabled={!seedDirty}
                onClick={() => { onChange({ seed: customSeed || undefined }); setSeedDirty(false); }}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-dark-900 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Apply
              </button>
              <button
                onClick={() => {
                  const r = Math.random().toString(36).slice(2, 9);
                  setCustomSeed(r);
                  onChange({ seed: r });
                  setSeedDirty(false);
                }}
                title="Random seed"
                className="px-3 py-2 rounded-lg text-sm bg-dark-900 border border-dark-700 text-gray-200 hover:bg-dark-800"
              >
                <i className="ri-shuffle-line" />
              </button>
            </div>
          </div>

          {/* Reset */}
          {(current.style || current.seed) && (
            <button
              onClick={() => { onReset(); setCustomSeed(''); }}
              className="w-full text-xs text-gray-400 hover:text-white py-1"
            >
              ← Reset to default ({globalStyle} · {name})
            </button>
          )}
        </div>

        {/* Danger zone — quick remove this person from the chart entirely */}
        {canEdit && (
          <div className="px-5 py-3 border-t border-dark-700 bg-rose-500/5">
            <div className="text-[10px] uppercase tracking-wider text-rose-300/80 mb-2 font-semibold">Remove from chart</div>
            <div className="flex gap-2">
              <button
                onClick={onOffboard}
                className="flex-1 px-3 py-2 text-xs rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                title="Marks status=offboarded — keeps history but hides from chart"
              >
                <i className="ri-logout-box-line mr-1" /> Offboard
              </button>
              <button
                onClick={onDeleteEmployee}
                className="flex-1 px-3 py-2 text-xs rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                title="Permanently delete from DB (use only if they were never in your org)"
              >
                <i className="ri-delete-bin-line mr-1" /> Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Avatar-style picker. Shows live thumbnails generated from a "Preview"
// seed so the customer can compare DiceBear styles before applying.
function AvatarStylePicker({ style, setStyle }: { style: AvatarStyle; setStyle: (s: AvatarStyle) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = AVATAR_STYLE_OPTIONS.find((o) => o.key === style) ?? AVATAR_STYLE_OPTIONS[0];
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} className="org-chart-header__btn" title="Avatar style">
        <i className={current.icon} /> {current.label}
        <i className="ri-arrow-down-s-line text-[10px]" />
      </button>
      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={280}>
        <div className="org-chart-theme-menu__label">Avatar style</div>
        {AVATAR_STYLE_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => { setStyle(o.key); setOpen(false); }}
            className={`org-chart-theme-menu__item ${o.key === style ? 'org-chart-theme-menu__item--active' : ''}`}
            style={{ alignItems: 'center', gap: 12 }}
          >
            {/* Live preview thumbnail */}
            <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', overflow: 'hidden', background: '#0f172a' }}>
              {o.key === 'initials' ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#34d399', color: '#0a0f1c', fontWeight: 700, fontSize: 12 }}>AB</div>
              ) : (
                <Avatar seed="Preview" style={o.key} size={32} />
              )}
            </div>
            <div>
              <div className="font-semibold">{o.label}</div>
              <div className="text-[10px] opacity-70">{o.desc}</div>
            </div>
            {o.key === style && <i className="ri-check-line text-emerald-400 ml-auto" />}
          </button>
        ))}
        <div className="px-2 py-2 mt-1 border-t border-white/10 text-[10px] text-emerald-300/70 flex items-center gap-1">
          <i className="ri-pushpin-line" /> Pinned — opens this way every visit.
        </div>
      </PortalDropdown>
    </>
  );
}

// Layout picker dropdown — same shape as ThemePicker for consistency.
function LayoutPicker({ layout, setLayout }: { layout: LayoutKey; setLayout: (l: LayoutKey) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = LAYOUT_OPTIONS.find((o) => o.key === layout) ?? LAYOUT_OPTIONS[0];
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} className="org-chart-header__btn" title="Layout style">
        <i className={current.icon} /> {current.label}
        <i className="ri-arrow-down-s-line text-[10px]" />
      </button>
      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={250}>
        <div className="org-chart-theme-menu__label">Layout</div>
        {LAYOUT_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => { setLayout(o.key); setOpen(false); }}
            className={`org-chart-theme-menu__item ${o.key === layout ? 'org-chart-theme-menu__item--active' : ''}`}
          >
            <i className={o.icon} />
            <div>
              <div className="font-semibold">{o.label}</div>
              <div className="text-[10px] opacity-70">{o.desc}</div>
            </div>
            {o.key === layout && <i className="ri-check-line text-emerald-400 ml-auto" />}
          </button>
        ))}
        <div className="px-2 py-2 mt-1 border-t border-white/10 text-[10px] text-emerald-300/70 flex items-center gap-1">
          <i className="ri-pushpin-line" /> Your picks are saved as the default — opens this way every time.
        </div>
      </PortalDropdown>
    </>
  );
}

// Background picker — choose animated background + accent + custom color.
function BackgroundPicker({
  background, setBackground, customColor, setCustomColor, accent, setAccent,
}: {
  background: BackgroundKey;
  setBackground: (b: BackgroundKey) => void;
  customColor: string;
  setCustomColor: (c: string) => void;
  accent: string;
  setAccent: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = BACKGROUND_OPTIONS.find((o) => o.key === background) ?? BACKGROUND_OPTIONS[0];
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} className="org-chart-header__btn" title="Background style">
        <i className={current.icon} /> {current.label}
        <i className="ri-arrow-down-s-line text-[10px]" />
      </button>
      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={270}>
        <div className="org-chart-theme-menu__label">Background</div>
        {BACKGROUND_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => { setBackground(o.key); if (o.key !== 'custom') setOpen(false); }}
            className={`org-chart-theme-menu__item ${o.key === background ? 'org-chart-theme-menu__item--active' : ''}`}
          >
            <i className={o.icon} />
            <div>
              <div className="font-semibold">{o.label}</div>
              <div className="text-[10px] opacity-70">{o.desc}</div>
            </div>
            {o.key === background && <i className="ri-check-line text-emerald-400 ml-auto" />}
          </button>
        ))}
        {background === 'custom' && (
          <div className="px-2 py-3 mt-1 border-t border-white/10">
            <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">Solid color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={customColor} onChange={(e) => setCustomColor(e.target.value)}
                className="w-10 h-10 rounded-lg cursor-pointer bg-transparent border border-white/20" />
              <input type="text" value={customColor} onChange={(e) => setCustomColor(e.target.value)}
                className="flex-1 bg-dark-900 border border-dark-700 rounded px-2 py-1 text-white text-xs font-mono" placeholder="#0a0f1c" />
            </div>
          </div>
        )}
        <div className="px-2 py-3 mt-1 border-t border-white/10">
          <label className="text-[10px] uppercase tracking-wider text-gray-400 block mb-1">Accent color (particles, glow)</label>
          <div className="flex items-center gap-2">
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)}
              className="w-10 h-10 rounded-lg cursor-pointer bg-transparent border border-white/20" />
            <input type="text" value={accent} onChange={(e) => setAccent(e.target.value)}
              className="flex-1 bg-dark-900 border border-dark-700 rounded px-2 py-1 text-white text-xs font-mono" placeholder="#34d399" />
          </div>
        </div>
        <div className="px-2 py-2 mt-1 border-t border-white/10 text-[10px] text-emerald-300/70 flex items-center gap-1">
          <i className="ri-pushpin-line" /> Pinned — opens this way every visit.
        </div>
      </PortalDropdown>
    </>
  );
}

// Theme picker dropdown.
function ThemePicker({ theme, setTheme }: { theme: ThemeKey; setTheme: (t: ThemeKey) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = THEME_OPTIONS.find((o) => o.key === theme) ?? THEME_OPTIONS[0];
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} className="org-chart-header__btn" title="Choose chart theme">
        <i className={current.icon} /> {current.label}
        <i className="ri-arrow-down-s-line text-[10px]" />
      </button>
      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)}>
        <div className="org-chart-theme-menu__label">Theme</div>
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => { setTheme(o.key); setOpen(false); }}
            className={`org-chart-theme-menu__item ${o.key === theme ? 'org-chart-theme-menu__item--active' : ''}`}
          >
            <i className={o.icon} />
            <div>
              <div className="font-semibold">{o.label}</div>
              <div className="text-[10px] opacity-70">{o.desc}</div>
            </div>
            {o.key === theme && <i className="ri-check-line text-emerald-400 ml-auto" />}
          </button>
        ))}
      </PortalDropdown>
    </>
  );
}

// ── Inline CSS ────────────────────────────────────────────────────────────

const ORG_CHART_CSS = `
.org-chart-wrap {
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.08);
  position: relative;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04);
}

@keyframes org-node-in {
  0%   { opacity: 0; transform: translateY(8px) scale(0.96); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes org-glow-pulse {
  0%, 100% { box-shadow: var(--card-shadow, 0 4px 6px rgba(0,0,0,0.18)), 0 0 0 0 var(--node-glow); }
  50%      { box-shadow: var(--card-shadow, 0 6px 10px rgba(0,0,0,0.25)), 0 0 18px 4px var(--node-glow); }
}

.org-node {
  border: 2px solid;
  border-radius: 12px;
  padding: 10px 16px 12px;
  min-width: 180px;
  text-align: center;
  position: relative;
  cursor: grab;
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.18s ease;
  animation: org-node-in 0.4s cubic-bezier(0.4, 0, 0.2, 1) both;
  transform-style: preserve-3d;
  user-select: none;
}
.org-node:hover {
  transform: translateY(-3px) scale(1.04);
  box-shadow: var(--hover-shadow);
  z-index: 10;
}
.org-node:active { cursor: grabbing; transform: translateY(-1px) scale(1.02); }
.org-node--selected { outline: 3px solid var(--node-border); outline-offset: 4px; }
.org-node--founder { animation: org-node-in 0.4s cubic-bezier(0.4, 0, 0.2, 1) both, org-glow-pulse 3.5s ease-in-out 0.5s infinite; }
.org-node--glass { backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.org-node--flat   { border-radius: 6px; }
.org-node--corporate { border-radius: 4px; padding: 12px 18px 14px; }
/* With-avatar nodes: avatar lives INSIDE the card now (not floating above)
 * so react-flow's node wrapper can never clip it. The card flexes to a
 * column layout: avatar → name → title → meta. */
.org-node--with-avatar {
  display: flex !important;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 16px 12px;
}

/* Belt-and-suspenders: never let anything outside react-flow clip our
 * node. Most clipping bugs come from a parent setting overflow: hidden. */
.react-flow__node-employee { overflow: visible !important; }

/* ── Avatar ── circular monogram with breathing scale + ring + sheen */
@keyframes org-avatar-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.05); }
}
@keyframes org-avatar-ring {
  0%, 100% { transform: scale(1);   opacity: 0.55; }
  50%      { transform: scale(1.22); opacity: 0;   }
}
@keyframes org-avatar-sheen {
  0%   { background-position: -120% 0; }
  100% { background-position: 220% 0; }
}
.org-avatar {
  position: relative;
  width: 48px; height: 48px;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 700; letter-spacing: 0.04em;
  border: 3px solid;
  overflow: visible;
  flex-shrink: 0;
  animation: org-avatar-breathe 4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  margin-bottom: 2px;
}
.org-avatar::before {
  content: '';
  position: absolute; inset: 0;
  border-radius: 50%;
  background: linear-gradient(110deg, transparent 38%, rgba(255,255,255,0.45) 50%, transparent 62%);
  background-size: 220% 100%;
  animation: org-avatar-sheen 4.5s ease-in-out infinite;
  pointer-events: none;
  overflow: hidden;
}
.org-avatar__text {
  position: relative;
  z-index: 1;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.35);
}
.org-avatar__ring {
  position: absolute; inset: -7px;
  border-radius: 50%;
  border: 2px solid;
  animation: org-avatar-ring 2.6s ease-out infinite;
  pointer-events: none;
}
.org-node--founder .org-avatar { width: 54px; height: 54px; font-size: 17px; animation-duration: 3s; }

/* Per-card edit pencil — appears on hover */
.org-node__edit {
  position: absolute;
  top: 6px; right: 6px;
  width: 24px; height: 24px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(255,255,255,0.15);
  color: #6ee7b7;
  font-size: 11px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
  z-index: 5;
  padding: 0;
}
.org-node:hover .org-node__edit { opacity: 1; transform: scale(1); }
.org-node__edit:hover {
  background: rgba(52, 211, 153, 0.25);
  transform: scale(1.1);
  color: #fff;
}

.org-node__crown {
  position: absolute;
  top: -16px; left: 50%;
  transform: translateX(-50%);
  font-size: 18px;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
}

.org-node__name {
  font-weight: 700;
  font-size: 13px;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.org-node__title { font-size: 11px; opacity: 0.85; margin-top: 3px; line-height: 1.25; }
.org-node__meta { display: flex; justify-content: center; gap: 6px; margin-top: 6px; }
.org-node__chip {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
  padding: 2px 7px; border-radius: 9999px;
  background: rgba(255,255,255,0.55);
  border: 1px solid currentColor;
}
.org-node__chip--root { background: var(--node-border); color: #fff !important; border-color: var(--node-border); }
.org-handle {
  width: 8px !important; height: 8px !important;
  border: 2px solid #fff !important; border-radius: 50% !important;
}

.react-flow__edge-path { stroke-dasharray: 6 4; animation: org-dash 1.2s linear infinite; }
@keyframes org-dash { to { stroke-dashoffset: -20; } }
/* Disable edge animation for flat + corporate themes. */
.org-node--flat ~ * .react-flow__edge-path,
.org-node--corporate ~ * .react-flow__edge-path { animation: none; stroke-dasharray: none; }

.org-chart-header {
  position: absolute;
  top: 16px; left: 16px;
  z-index: 5;
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  color: #e5e7eb;
  flex-wrap: wrap;
  max-width: calc(100% - 32px);
}
.org-chart-header__title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.org-chart-header__title i { color: #34d399; font-size: 16px; }
.org-chart-header__stat {
  display: flex; flex-direction: column; align-items: center;
  padding: 0 12px; border-left: 1px solid rgba(255,255,255,0.1);
}
.org-chart-header__count { font-size: 18px; font-weight: 700; color: #fff; line-height: 1; }
.org-chart-header__label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-top: 2px; }
.org-chart-header__hint {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; color: #94a3b8;
  padding: 4px 8px; border-radius: 8px;
  background: rgba(255,255,255,0.05);
  border: 1px dashed rgba(255,255,255,0.1);
}
.org-chart-header__btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600;
  padding: 5px 10px; border-radius: 8px;
  background: rgba(52, 211, 153, 0.15);
  border: 1px solid rgba(52, 211, 153, 0.3);
  color: #6ee7b7;
  cursor: pointer; transition: all 0.15s;
}
.org-chart-header__btn:hover { background: rgba(52, 211, 153, 0.25); border-color: rgba(52, 211, 153, 0.5); transform: translateY(-1px); }
.org-chart-header__btn--active { background: rgba(52, 211, 153, 0.28); border-color: rgba(52, 211, 153, 0.55); color: #fff; }

.org-chart-theme-picker { position: relative; }
.org-chart-theme-menu {
  background: rgba(15, 23, 42, 0.96);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  padding: 6px;
  /* width set inline via PortalDropdown — never grow wider than that. */
  box-sizing: border-box;
}
.org-chart-theme-menu__label {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
  color: #94a3b8; padding: 6px 8px;
}
.org-chart-theme-menu__item {
  display: flex; align-items: center; gap: 10px;
  width: 100%;
  padding: 8px 10px; border-radius: 8px;
  background: transparent; border: none;
  color: #e5e7eb; cursor: pointer; text-align: left;
  transition: background 0.12s;
  box-sizing: border-box;
}
.org-chart-theme-menu__item > div {
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.org-chart-theme-menu__item > div > div:first-child {
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.org-chart-theme-menu__item > div > div:last-child {
  font-size: 10.5px;
  line-height: 1.25;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.org-chart-theme-menu__item:hover { background: rgba(255,255,255,0.06); }
.org-chart-theme-menu__item--active { background: rgba(52, 211, 153, 0.1); color: #6ee7b7; }
.org-chart-theme-menu__item i:first-child { font-size: 16px; color: #34d399; flex-shrink: 0; }

.org-chart-controls button {
  background: rgba(15, 23, 42, 0.9) !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  color: #e5e7eb !important;
  transition: all 0.15s;
}
.org-chart-controls button:hover { background: rgba(52, 211, 153, 0.2) !important; }
.org-chart-controls svg { fill: currentColor !important; }
`;
