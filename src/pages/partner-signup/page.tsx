import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

export default function PartnerSignup() {
  const [form, setForm] = useState({
    name: '', contact_email: '', phone: '', gst_number: '', city: '', state: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError(null);
    const { error } = await supabase.from('partners').insert({ ...form, status: 'pending' });
    if (error) setError(error.message);
    else setDone(true);
    setSubmitting(false);
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950 px-4">
        <div className="max-w-md w-full bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
          <i className="ri-checkbox-circle-line text-5xl text-green-400 block mb-4" />
          <h1 className="text-xl text-white font-semibold mb-2">Application submitted</h1>
          <p className="text-gray-400 text-sm">
            Hum 24-48 hours mein review karke aapko email karenge. Approval ke baad aapko login credentials mil jayenge.
          </p>
          <Link to="/login" className="inline-block mt-6 text-cyan-400 text-sm hover:underline">Already approved? Sign in →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-950 flex items-center justify-center px-4 py-10">
      <div className="max-w-lg w-full bg-dark-800 border border-dark-700 rounded-xl p-8">
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-widest text-cyan-400 font-semibold">Wellness Extract</p>
          <h1 className="text-xl text-white font-semibold mt-1">Become a Partner</h1>
          <p className="text-gray-500 text-sm mt-1">Sell Wellness Extract to your customers and earn recurring commission.</p>
        </div>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        <form onSubmit={submit} className="space-y-3">
          <Input label="Company Name *"  value={form.name}          onChange={update('name')}          required />
          <Input label="Contact Email *" type="email" value={form.contact_email} onChange={update('contact_email')} required />
          <Input label="Phone"           value={form.phone}         onChange={update('phone')} />
          <Input label="GST Number"      value={form.gst_number}    onChange={update('gst_number')} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="City"  value={form.city}  onChange={update('city')} />
            <Input label="State" value={form.state} onChange={update('state')} />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-2 bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit Application'}
          </button>
        </form>

        <p className="text-[11px] text-gray-600 text-center mt-5">
          Already a partner? <Link to="/login" className="text-cyan-400 hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

function Input({ label, ...rest }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span>
      <input
        {...rest}
        className="mt-1 w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
      />
    </label>
  );
}
