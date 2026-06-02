import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

/**
 * /invoices/:id — two-mode billing surface inspired by the Stripe customer
 * portal:
 *
 *   1. Summary card (default) — clean "Invoice paid" hero + key facts +
 *      Download invoice / Download receipt buttons. Approachable.
 *   2. Detailed tax invoice (toggle "View invoice and payment details" OR
 *      hit ?view=detail) — full Indian GST invoice with line items, CGST/
 *      SGST/IGST split, bank details. Print-friendly for tax compliance.
 *
 * Download buttons trigger window.print() in the right mode (?print=invoice
 * vs ?print=receipt). Browser's Save-as-PDF gives the customer a PDF.
 */

type Invoice = {
  id: string;
  invoice_number: string;
  organization_id: string;
  partner_id: string | null;
  license_id: string | null;
  plan_id: string | null;
  amount_inr: number;
  gst_pct: number;
  gst_amount_inr: number;
  total_inr: number;
  status: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  issued_at: string;
  paid_at: string | null;
  notes: string | null;
  bill_from: string;
  is_renewal: boolean;
};

type Org = {
  id: string; name: string; gst_number: string | null; pan_number: string | null;
  address: string | null; city: string | null; state: string | null;
  postal_code: string | null; country: string | null; phone: string | null;
};

type BillingEntity = {
  legal_name: string; brand_name: string | null;
  gst_number: string | null; pan_number: string | null;
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; postal_code: string | null; country: string;
  contact_email: string | null; phone: string | null; website: string | null;
  bank_name: string | null; bank_account_number: string | null; bank_ifsc: string | null;
};

type Plan = { code: string; name: string; billing_cycle: string };

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [inv, setInv] = useState<Invoice | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [be, setBe] = useState<BillingEntity | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Human-friendly payment method (e.g. "VISA · 4242", "UPI · 9991@ybl").
  // Looked up from Razorpay via the razorpay-payment-method edge fn on
  // mount. Falls back to "—" if Razorpay is unreachable.
  const [payMethod, setPayMethod] = useState<string | null>(null);

  // ?view=detail (or expanded) → show full tax invoice below the summary.
  // ?print=invoice / ?print=receipt → trigger window.print on mount.
  const view = params.get('view');
  const isDetailed = view === 'detail';

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      try {
        const { data: i, error: ie } = await supabase
          .from('invoices').select('*').eq('id', id).maybeSingle();
        if (ie) throw new Error(ie.message);
        if (!i) throw new Error('Invoice not found or access denied.');
        const invoice = i as Invoice;
        setInv(invoice);

        const [oRes, beRes, pRes] = await Promise.all([
          supabase.from('organizations')
            .select('id, name, gst_number, pan_number, address, city, state, postal_code, country, phone')
            .eq('id', invoice.organization_id).maybeSingle(),
          supabase.from('billing_entity').select('*').eq('id', 1).maybeSingle(),
          invoice.plan_id
            ? supabase.from('plans').select('code, name, billing_cycle').eq('id', invoice.plan_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        setOrg((oRes.data ?? null) as Org | null);
        setBe((beRes.data ?? null) as BillingEntity | null);
        setPlan((pRes.data ?? null) as Plan | null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load invoice');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Resolve the friendly payment-method label from Razorpay (best-effort).
  useEffect(() => {
    if (!inv?.razorpay_payment_id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-payment-method`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ payment_id: inv.razorpay_payment_id }),
        });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && j.ok && j.label) setPayMethod(j.label);
      } catch { /* ignore — fallback to '—' */ }
    })();
    return () => { cancelled = true; };
  }, [inv?.razorpay_payment_id]);

  // Auto-print on first paint if URL asks for it. Strip the param after
  // firing so a back-button revisit doesn't keep printing.
  useEffect(() => {
    const wantPrint = params.get('print');
    if (loading || !wantPrint) return;
    const t = setTimeout(() => {
      window.print();
      const next = new URLSearchParams(params);
      next.delete('print');
      setParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [loading, params, setParams]);

  const downloadInvoice = () => {
    // Switch to detail view so the tax-invoice block is in the DOM, then print.
    const next = new URLSearchParams(params);
    next.set('view', 'detail');
    next.set('print', 'invoice');
    setParams(next, { replace: true });
  };
  const downloadReceipt = () => {
    const next = new URLSearchParams(params);
    next.delete('view');                  // receipt is the summary card
    next.set('print', 'receipt');
    setParams(next, { replace: true });
  };
  const toggleDetail = () => {
    const next = new URLSearchParams(params);
    if (isDetailed) next.delete('view');
    else next.set('view', 'detail');
    setParams(next, { replace: true });
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-white text-gray-500 text-sm">Loading…</div>;
  }
  if (error || !inv || !be) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white text-gray-700 p-6">
        <p className="text-sm mb-3">{error ?? 'Invoice not found.'}</p>
        <button onClick={() => navigate(-1)} className="text-sm text-indigo-600 hover:text-indigo-700">← Back</button>
      </div>
    );
  }

  const subtotal = Number(inv.amount_inr);
  const gst      = Number(inv.gst_amount_inr);
  const total    = Number(inv.total_inr);
  const dItem    = describeLineItem(inv, plan);
  const sameState = (org?.state ?? '').toLowerCase() === (be.state ?? '').toLowerCase();
  const halfGst  = +(gst / 2).toFixed(2);
  const printMode = params.get('print');  // 'invoice' or 'receipt' while a print is fired

  return (
    <div className="min-h-screen bg-black print:bg-white">
      {/* ── Brand header (hidden in print) ─────────────────────────────── */}
      <div className="max-w-2xl mx-auto px-4 pt-8 pb-3 flex items-center gap-2 print:hidden">
        <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <i className="ri-shield-check-line text-emerald-400 text-lg" />
        </div>
        <h1 className="text-white text-base font-semibold">{be.brand_name ?? be.legal_name}</h1>
        <button onClick={() => navigate(-1)} className="ml-auto text-xs text-gray-400 hover:text-white">← Back</button>
      </div>

      {/* ── Summary card (Stripe-style) ───────────────────────────────── */}
      <div className={`max-w-2xl mx-auto px-4 pb-8 ${printMode === 'invoice' ? 'print:hidden' : ''}`}>
        <div className="bg-white rounded-2xl shadow-2xl p-8 print:shadow-none print:rounded-none">
          {/* Hero icon */}
          <div className="flex justify-center mb-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-xl bg-gray-100 flex items-center justify-center">
                <i className="ri-file-list-2-line text-3xl text-gray-400" />
              </div>
              {inv.status === 'paid' && (
                <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center border-2 border-white">
                  <i className="ri-check-line text-white text-sm" />
                </div>
              )}
            </div>
          </div>

          {/* Status + amount */}
          <p className="text-center text-sm text-gray-600 mb-1">
            {inv.status === 'paid' ? 'Invoice paid' : inv.status === 'pending' ? 'Invoice pending' : `Invoice ${inv.status}`}
          </p>
          <h2 className="text-center text-4xl font-bold text-gray-900 tracking-tight mb-4">
            ₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </h2>

          {/* "View invoice and payment details" toggle */}
          <button
            type="button"
            onClick={toggleDetail}
            className="block mx-auto text-sm text-gray-700 hover:text-gray-900 mb-8 underline-offset-2 hover:underline print:hidden"
          >
            {isDetailed ? 'Hide invoice details' : 'View invoice and payment details'} ›
          </button>

          {/* Key facts */}
          <div className="space-y-3 mb-6 text-sm">
            <Row label="Invoice number" value={<span className="font-mono">{inv.invoice_number}</span>} />
            <Row label="Issued" value={new Date(inv.issued_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} />
            {inv.paid_at && (
              <Row label="Payment date" value={new Date(inv.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} />
            )}
            <Row label="Payment method" value={payMethod ?? (inv.razorpay_payment_id ? 'Loading…' : '—')} />
          </div>

          {/* Download buttons */}
          <div className="grid grid-cols-2 gap-3 print:hidden">
            <button
              type="button"
              onClick={downloadInvoice}
              className="border border-gray-300 hover:border-gray-400 text-gray-900 text-sm font-medium py-3 rounded-lg"
            >
              Download invoice
            </button>
            <button
              type="button"
              onClick={downloadReceipt}
              className="bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium py-3 rounded-lg"
            >
              Download receipt
            </button>
          </div>
        </div>
      </div>

      {/* ── Detailed tax invoice (collapsed by default) ───────────────── */}
      {(isDetailed || printMode === 'invoice') && (
        <div className={`max-w-3xl mx-auto px-4 pb-12 ${printMode === 'receipt' ? 'print:hidden' : ''}`}>
          <div className="bg-white rounded-lg shadow-sm p-8 print:shadow-none print:rounded-none">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-gray-200 pb-4 mb-5">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{be.brand_name ?? be.legal_name}</h1>
                <p className="text-[11px] text-gray-500 mt-1">{be.legal_name}</p>
                <p className="text-[11px] text-gray-500 mt-2 leading-tight">
                  {be.address_line1}{be.address_line2 ? `, ${be.address_line2}` : ''}<br/>
                  {[be.city, be.state, be.postal_code].filter(Boolean).join(', ')}<br/>
                  {be.country}
                </p>
                <p className="text-[11px] text-gray-500 mt-1">
                  {be.contact_email && <>Email: {be.contact_email}<br/></>}
                  {be.phone && <>Phone: {be.phone}<br/></>}
                  {be.website && <>{be.website}</>}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wider text-gray-500">Tax Invoice</p>
                <p className="text-lg font-bold text-gray-900 font-mono mt-1">{inv.invoice_number}</p>
                <p className="text-[11px] text-gray-500 mt-2">
                  <span className="font-medium text-gray-700">Issued:</span> {new Date(inv.issued_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </p>
                {inv.paid_at && (
                  <p className="text-[11px] text-gray-500">
                    <span className="font-medium text-gray-700">Paid:</span> {new Date(inv.paid_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </p>
                )}
                <p className={`mt-2 inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                  inv.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : inv.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-gray-200 text-gray-700'
                }`}>{inv.status}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-[11px] text-gray-600 mb-5">
              <div>
                <p className="uppercase text-gray-500 tracking-wider mb-0.5">From</p>
                {be.gst_number && <p>GSTIN: <span className="font-mono text-gray-900">{be.gst_number}</span></p>}
                {be.pan_number && <p>PAN: <span className="font-mono text-gray-900">{be.pan_number}</span></p>}
              </div>
              <div>
                <p className="uppercase text-gray-500 tracking-wider mb-0.5">Billed To</p>
                <p className="font-semibold text-gray-900">{org?.name ?? '—'}</p>
                <p className="leading-tight">
                  {org?.address && <>{org.address}<br/></>}
                  {[org?.city, org?.state, org?.postal_code].filter(Boolean).join(', ')}
                  {org?.country && <><br/>{org.country}</>}
                </p>
                {org?.gst_number && <p className="mt-1">GSTIN: <span className="font-mono text-gray-900">{org.gst_number}</span></p>}
                {org?.pan_number && <p>PAN: <span className="font-mono text-gray-900">{org.pan_number}</span></p>}
              </div>
            </div>

            <table className="w-full text-sm border-t border-b border-gray-200 mb-5">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left text-[11px] uppercase tracking-wider text-gray-500 px-3 py-2">Description</th>
                  <th className="text-right text-[11px] uppercase tracking-wider text-gray-500 px-3 py-2 w-24">HSN/SAC</th>
                  <th className="text-right text-[11px] uppercase tracking-wider text-gray-500 px-3 py-2 w-28">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="px-3 py-3">
                    <p className="text-gray-900 font-medium">{dItem.title}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{dItem.subtitle}</p>
                  </td>
                  <td className="px-3 py-3 text-right text-gray-700 font-mono">997331</td>
                  <td className="px-3 py-3 text-right text-gray-900 font-mono">{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                </tr>
              </tbody>
            </table>

            <div className="flex justify-end">
              <table className="text-sm">
                <tbody>
                  <tr>
                    <td className="text-gray-600 pr-6 py-1">Subtotal</td>
                    <td className="text-right text-gray-900 font-mono w-32">₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  </tr>
                  {sameState ? (
                    <>
                      <tr>
                        <td className="text-gray-600 pr-6 py-1">CGST @ {(inv.gst_pct / 2).toFixed(1)}%</td>
                        <td className="text-right text-gray-900 font-mono">₹ {halfGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 pr-6 py-1">SGST @ {(inv.gst_pct / 2).toFixed(1)}%</td>
                        <td className="text-right text-gray-900 font-mono">₹ {halfGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    </>
                  ) : (
                    <tr>
                      <td className="text-gray-600 pr-6 py-1">IGST @ {inv.gst_pct}%</td>
                      <td className="text-right text-gray-900 font-mono">₹ {gst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    </tr>
                  )}
                  <tr className="border-t border-gray-300">
                    <td className="text-gray-900 font-bold pr-6 py-2 text-base">Total</td>
                    <td className="text-right text-gray-900 font-bold font-mono text-base py-2">₹ {total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-2 gap-6 mt-8 pt-5 border-t border-gray-200 text-[11px] text-gray-600">
              <div>
                <p className="uppercase text-gray-500 tracking-wider mb-1">Payment details</p>
                {inv.razorpay_payment_id && (
                  <p>Razorpay Payment ID: <span className="font-mono text-gray-900">{inv.razorpay_payment_id}</span></p>
                )}
                {inv.razorpay_order_id && (
                  <p>Razorpay Order ID: <span className="font-mono text-gray-900">{inv.razorpay_order_id}</span></p>
                )}
                <p className="mt-1">Status: <span className="font-medium text-gray-900 uppercase">{inv.status}</span></p>
              </div>
              {(be.bank_name || be.bank_account_number) && (
                <div>
                  <p className="uppercase text-gray-500 tracking-wider mb-1">Bank details</p>
                  {be.bank_name && <p>{be.bank_name}</p>}
                  {be.bank_account_number && <p>A/c: <span className="font-mono text-gray-900">{be.bank_account_number}</span></p>}
                  {be.bank_ifsc && <p>IFSC: <span className="font-mono text-gray-900">{be.bank_ifsc}</span></p>}
                </div>
              )}
            </div>

            <p className="text-[10px] text-gray-400 text-center mt-8 pt-4 border-t border-gray-100">
              This is a computer-generated invoice and does not require a signature. For queries contact {be.contact_email ?? 'support'}.
            </p>
          </div>
        </div>
      )}

      <style>{`
        @media print {
          body { background: white; }
          .print\\:hidden { display: none !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:rounded-none { border-radius: 0 !important; }
          .print\\:bg-white { background: white !important; }
          @page { margin: 12mm; }
        }
      `}</style>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </div>
  );
}

function describeLineItem(inv: Invoice, plan: Plan | null): { title: string; subtitle: string } {
  const kind = (inv.notes ?? '').toLowerCase();
  if (kind === 'trial_verify') {
    return { title: 'Card verification charge', subtitle: 'Refundable ₹2 hold for card mandate setup before 14-day trial.' };
  }
  if (kind === 'seats') {
    return { title: `Additional seats (prorated)${plan ? ` — ${plan.name}` : ''}`, subtitle: 'Pro-rated for days remaining in current billing cycle.' };
  }
  if (kind === 'upgrade') {
    return { title: `Plan upgrade${plan ? ` — ${plan.name}` : ''}`, subtitle: plan?.billing_cycle === 'yearly' ? 'Annual subscription' : 'Monthly subscription' };
  }
  if (kind === 'addon') {
    return { title: `Add-on subscription${plan ? ` — ${plan.name}` : ''}`, subtitle: 'Per-seat add-on activation' };
  }
  if (kind === 'renewal' || inv.is_renewal) {
    return { title: `Subscription renewal${plan ? ` — ${plan.name}` : ''}`, subtitle: plan?.billing_cycle === 'yearly' ? 'Annual renewal' : 'Monthly renewal' };
  }
  return { title: `Subscription${plan ? ` — ${plan.name}` : ''}`, subtitle: inv.notes ?? 'Service charge' };
}
