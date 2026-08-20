import { useEffect, useRef, useState } from 'react';
import type { Category } from '@/lib/dataHooks';

/* Click-to-edit productivity category. Persists via the supplied onChange
   (typically useProductivityRules().upsertRule).

   Two changes from the original:
     • Colours are design tokens, not Tailwind emerald/red/gray. The old
       `text-emerald-400` on `bg-emerald-500/15` went through the light-theme
       remap layer and came out violet — "productive" was rendering in the
       accent colour, which is what the neutral rows use elsewhere.
     • The dropdown is viewport-anchored (position: fixed). Absolute positioning
       put it inside the table's `overflow-x-auto` wrapper, which clipped it on
       every row near the panel edge. */

const TONE: Record<Category, string> = {
  productive: 'var(--d-success)',
  unproductive: 'var(--d-danger)',
  neutral: 'var(--d-neutral)',
};

const opts: Category[] = ['productive', 'neutral', 'unproductive'];

type Props = {
  value: Category;
  onChange: (next: Category) => void | Promise<void>;
  disabled?: boolean;
  size?: 'sm' | 'md';
};

export default function CategoryBadge({ value, onChange, disabled, size = 'sm' }: Props) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setAnchor(null);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // A scroll moves the trigger out from under a fixed menu — close instead of
    // letting it float somewhere meaningless.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { setAnchor(null); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const height = opts.length * 26 + 8;
    const below = window.innerHeight - r.bottom;
    setAnchor({
      left: Math.min(r.left, window.innerWidth - 150),
      top: below < height ? Math.max(8, r.top - height - 4) : r.bottom + 4,
    });
  };

  const pad = size === 'md' ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[10px]';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        className={`${pad} rounded-md font-medium inline-flex items-center gap-1 ${disabled ? '' : 'cursor-pointer'}`}
        style={{
          color: TONE[value],
          background: 'var(--d-sunken)',
          border: '1px solid var(--d-line-soft)',
        }}
      >
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: TONE[value] }} />
        {value}
        {!disabled && <i className="ri-arrow-down-s-line text-[10px]" />}
      </button>

      {open && !disabled && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="menu"
          style={{ position: 'fixed', left: anchor.left, top: anchor.top, right: 'auto', minWidth: 142 }}
        >
          {opts.map((o) => (
            <button
              key={o}
              type="button"
              onClick={async (e) => { e.stopPropagation(); setAnchor(null); await onChange(o); }}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: TONE[o] }} />
              <span className="flex-1 text-left capitalize">{o}</span>
              {o === value && <i className="ri-check-line text-[12px]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
