import { useEffect, useRef, useState } from 'react';
import type { Category } from '@/lib/dataHooks';

const styles: Record<Category, string> = {
  productive: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25',
  unproductive: 'bg-red-500/15 text-red-400 border border-red-500/25',
  neutral: 'bg-gray-500/15 text-gray-400 border border-gray-500/25',
};

const opts: Category[] = ['productive', 'neutral', 'unproductive'];

type Props = {
  value: Category;
  onChange: (next: Category) => void | Promise<void>;
  disabled?: boolean;
  size?: 'sm' | 'md';
};

// Click-to-edit category badge. Persists via the supplied onChange handler (typically
// useProductivityRules().upsertRule).
export default function CategoryBadge({ value, onChange, disabled, size = 'sm' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const padding = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[10px]';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={`${padding} rounded-md font-medium ${styles[value]} flex items-center gap-1 ${disabled ? '' : 'cursor-pointer hover:opacity-80'}`}
      >
        {value}
        {!disabled && <i className="ri-arrow-down-s-line text-[10px]" />}
      </button>
      {open && !disabled && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute z-30 mt-1 right-0 bg-dark-800 border border-dark-700 rounded-lg shadow-xl py-1 min-w-[120px] overflow-hidden"
        >
          {opts.map((o) => (
            <button
              key={o}
              type="button"
              onClick={async (e) => { e.stopPropagation(); setOpen(false); await onChange(o); }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                o === value ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-300 hover:bg-dark-700'
              }`}
            >
              {o === value && <i className="ri-check-line text-[10px]" />}
              <span className="capitalize">{o}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
