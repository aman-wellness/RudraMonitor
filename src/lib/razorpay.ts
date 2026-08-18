import { supabase } from './supabase';

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document'));
    if (document.querySelector(`script[src="${SCRIPT_URL}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Razorpay Checkout script'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance { open: () => void; on: (e: string, fn: (...a: unknown[]) => void) => void; }
interface RazorpayConstructor { new (options: Record<string, unknown>): RazorpayInstance; }
declare global {
  interface Window { Razorpay?: RazorpayConstructor }
}

// Subscription handler returns these — Razorpay's signature is computed
// over `payment_id + '|' + subscription_id` with HMAC-SHA256 keyed on the
// merchant's KEY_SECRET. We forward all three to the verify endpoint so it
// can validate without round-tripping the Razorpay API.
export interface RazorpaySubscriptionResponse {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

export async function startSubscriptionCheckout(opts: {
  keyId: string;
  subscriptionId: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string | null;
  amountLabel?: string;
  onSuccess?: (resp: RazorpaySubscriptionResponse) => void;
  onDismiss?: () => void;
}): Promise<void> {
  await loadScript();
  if (!window.Razorpay) throw new Error('Razorpay not loaded');
  const rzp = new window.Razorpay({
    key: opts.keyId,
    subscription_id: opts.subscriptionId,
    name: 'Rudrans',
    description: opts.amountLabel
      ? `Card verification charge: ${opts.amountLabel} (held now, refunded after trial)`
      : 'Card verification — refundable',
    prefill: {
      name: opts.customerName ?? '',
      email: opts.customerEmail ?? '',
      contact: opts.customerPhone ?? '',
    },
    theme: { color: '#10b981' },
    handler: (resp: RazorpaySubscriptionResponse) => opts.onSuccess?.(resp),
    modal: { ondismiss: () => opts.onDismiss?.() },
  });
  rzp.open();
}

export interface RazorpayOrderResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export async function startOrderCheckout(opts: {
  keyId: string;
  orderId: string;
  amount: number;          // paise
  currency: string;        // "INR" or "USD"
  description?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string | null;
  onSuccess?: (resp: RazorpayOrderResponse) => void;
  onDismiss?: () => void;
}): Promise<void> {
  await loadScript();
  if (!window.Razorpay) throw new Error('Razorpay not loaded');
  const rzp = new window.Razorpay({
    key: opts.keyId,
    order_id: opts.orderId,
    amount: opts.amount,
    currency: opts.currency,
    name: 'Rudrans',
    description: opts.description ?? 'One-time charge',
    prefill: {
      name: opts.customerName ?? '',
      email: opts.customerEmail ?? '',
      contact: opts.customerPhone ?? '',
    },
    theme: { color: '#10b981' },
    handler: (resp: RazorpayOrderResponse) => opts.onSuccess?.(resp),
    modal: { ondismiss: () => opts.onDismiss?.() },
  });
  rzp.open();
}

export async function payInvoice(opts: {
  invoiceId: string;
  customerEmail?: string;
  customerName?: string;
  onSuccess?: (resp: RazorpayResponse) => void;
  onDismiss?: () => void;
}): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('not authenticated');

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-create-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ invoice_id: opts.invoiceId }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  const { order_id, amount, currency, key_id, invoice_number } = await res.json();

  await loadScript();
  if (!window.Razorpay) throw new Error('Razorpay not loaded');

  const rzp = new window.Razorpay({
    key: key_id,
    amount,
    currency,
    order_id,
    name: 'Rudrans',
    description: `Invoice ${invoice_number}`,
    prefill: {
      email: opts.customerEmail ?? '',
      name: opts.customerName ?? '',
    },
    theme: { color: '#0891b2' },
    handler: (response: RazorpayResponse) => {
      // The webhook is the source of truth for marking the invoice paid.
      // This callback fires *before* the webhook in some cases — UI should poll/refetch.
      opts.onSuccess?.(response);
    },
    modal: {
      ondismiss: () => opts.onDismiss?.(),
    },
  });
  rzp.open();
}
