import { type ReactNode, useEffect } from 'react';

// Shared dark-theme modal shell — mirrors the overlay pattern used across
// `src/pages/employees/credentials/page.tsx` so governance modals feel
// visually identical to credentials modals.

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  maxWidthClass?: string;        // e.g. 'max-w-lg', 'max-w-2xl'
}

export default function ModalShell({ title, subtitle, onClose, footer, children, maxWidthClass = 'max-w-lg' }: Props) {
  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}
    >
      <div
        className={`bg-dark-800 border border-dark-700 rounded-xl w-full ${maxWidthClass} max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-dark-700 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-white">{title}</h2>
            {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-dark-700 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
