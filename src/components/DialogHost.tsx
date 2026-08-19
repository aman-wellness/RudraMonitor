import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { useTheme } from '@/context/ThemeContext';
import { subscribeDialog, type DialogRequest } from '@/lib/notify';

/* Mounted once at the app root. Renders the toast surface plus the modal that
   backs confirmDialog() / promptDialog().

   Accessibility, since these replace native dialogs that had it for free:
     • role="alertdialog" + aria-modal, labelled by its own heading
     • focus moves to the primary control on open and returns to the previously
       focused element on close
     • Tab is trapped inside the dialog
     • Escape and a backdrop click both cancel
     • the underlying page is inert to pointer events while it's open */

export default function DialogHost() {
  const { isDark } = useTheme();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');

  const panelRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeDialog((r) => {
    setRequest(r);
    setValue(r?.defaultValue ?? '');
  }), []);

  const close = useCallback(
    (result: boolean | string | null) => {
      setRequest((current) => {
        current?.resolve(result);
        return null;
      });
    },
    [],
  );

  // Remember what had focus, move it in, and put it back on close.
  useEffect(() => {
    if (!request) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => primaryRef.current?.focus(), 20);
    return () => {
      clearTimeout(t);
      restoreTo.current?.focus?.();
    };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(request.kind === 'prompt' ? null : false);
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep focus inside the panel.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, close]);

  const submit = () => {
    if (!request) return;
    close(request.kind === 'prompt' ? value : true);
  };

  const danger = request?.tone === 'danger';

  return (
    <>
      <Toaster
        theme={isDark ? 'dark' : 'light'}
        position="bottom-right"
        closeButton
        richColors
        gap={10}
        toastOptions={{ className: 'dash-toast' }}
      />

      {request && (
        <div
          className="dash dlg-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close(request.kind === 'prompt' ? null : false);
          }}
        >
          <div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`dlg-title-${request.id}`}
            aria-describedby={request.body ? `dlg-body-${request.id}` : undefined}
            className="dlg"
          >
            <div className="flex items-start gap-3">
              <span className={`dlg-icon ${danger ? 'is-danger' : ''}`}>
                <i
                  className={
                    danger
                      ? 'ri-error-warning-line'
                      : request.kind === 'prompt'
                        ? 'ri-edit-line'
                        : 'ri-question-line'
                  }
                />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id={`dlg-title-${request.id}`} className="dlg-title">
                  {request.title}
                </h2>
                {request.body && (
                  <p id={`dlg-body-${request.id}`} className="dlg-body">
                    {request.body}
                  </p>
                )}
              </div>
            </div>

            {request.kind === 'prompt' && (
              <span className="field mt-3.5">
                <input
                  ref={(el) => {
                    primaryRef.current = el;
                  }}
                  type="text"
                  value={value}
                  placeholder={request.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  className="w-full text-[12px]"
                />
              </span>
            )}

            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                onClick={() => close(request.kind === 'prompt' ? null : false)}
                className="dlg-btn"
              >
                {request.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={(el) => {
                  if (request.kind === 'confirm') primaryRef.current = el;
                }}
                onClick={submit}
                className={`dlg-btn is-primary ${danger ? 'is-danger' : ''}`}
              >
                {request.confirmLabel ?? (request.kind === 'prompt' ? 'Save' : 'Confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
