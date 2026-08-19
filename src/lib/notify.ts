import { toast } from 'sonner';

/* ============================================================================
   App-wide notifications.

   Two distinct jobs, because they are not the same problem:

     • notify.*        — fire-and-forget feedback. Replaces alert(). Non-blocking,
                         stacks, auto-dismisses. Backed by sonner.
     • confirmDialog / promptDialog
                       — a decision the app must WAIT for. Replaces confirm()
                         and prompt(). A toast can't do this: it needs focus, a
                         modal barrier, and a promise the caller can await.

   Everything goes through this module rather than importing sonner directly, so
   the toast library is swappable and every call site gets consistent wording,
   duration and tone.
   ========================================================================== */

type ToastOpts = { description?: string; duration?: number };

/** Error text from a thrown value, without the "[object Object]" trap. */
export const errText = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Unexpected error';
};

export const notify = {
  success: (message: string, opts?: ToastOpts) => toast.success(message, opts),
  error: (message: string, opts?: ToastOpts) =>
    // Failures get longer on screen than successes — the user usually has to
    // read and act on them.
    toast.error(message, { duration: 6500, ...opts }),
  info: (message: string, opts?: ToastOpts) => toast.info(message, opts),
  warning: (message: string, opts?: ToastOpts) => toast.warning(message, { duration: 5500, ...opts }),
  loading: (message: string) => toast.loading(message),
  dismiss: (id?: string | number) => toast.dismiss(id),
  /** Shows loading → success/error around a promise. */
  promise: <T,>(
    p: Promise<T>,
    msgs: { loading: string; success: string | ((v: T) => string); error?: string },
  ) =>
    toast.promise(p, {
      loading: msgs.loading,
      success: msgs.success,
      error: (err: unknown) => msgs.error ?? errText(err),
    }),
  /** Convenience for the very common "operation failed" shape. */
  fail: (what: string, err: unknown) => toast.error(what, { description: errText(err), duration: 6500 }),
};

/* --------------------------------------------------------------- dialogs --- */

export type DialogTone = 'danger' | 'default';

export type DialogRequest = {
  id: number;
  kind: 'confirm' | 'prompt';
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  /** prompt only */
  placeholder?: string;
  defaultValue?: string;
  resolve: (value: boolean | string | null) => void;
};

type Listener = (request: DialogRequest | null) => void;

let listener: Listener | null = null;
let seq = 0;

/** Host registration. Only <DialogHost /> calls this. */
export const subscribeDialog = (fn: Listener) => {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
};

export type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

/**
 * Awaitable confirmation. Resolves true when the user confirms.
 *
 * Falls back to the native confirm() if no host is mounted — better a plain
 * dialog than a destructive action that silently proceeds (or never runs)
 * because the provider is missing from some route.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(window.confirm([opts.title, opts.body].filter(Boolean).join('\n\n')));
      return;
    }
    listener({
      id: ++seq,
      kind: 'confirm',
      tone: 'default',
      ...opts,
      resolve: (v) => resolve(v === true),
    });
  });
}

export type PromptOptions = {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
};

/** Awaitable text input. Resolves null when cancelled or left blank. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(window.prompt(opts.title, opts.defaultValue ?? ''));
      return;
    }
    listener({
      id: ++seq,
      kind: 'prompt',
      ...opts,
      resolve: (v) => resolve(typeof v === 'string' && v.trim() !== '' ? v : null),
    });
  });
}
