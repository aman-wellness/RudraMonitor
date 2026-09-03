// "Website pricing cards" tab of /admin/plans — manages public.site_plans,
// the rows behind the marketing site's /pricing plan cards. Purely
// presentational config; billing plans live in the other tab.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { confirmDialog, notify } from '@/lib/notify';
import type { SitePlan } from '@/lib/useSitePlans';

const input = 'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span><div className="mt-1">{children}</div></label>;
}

const EMPTY: Partial<SitePlan> = {
  name: '', tagline: '', price_monthly: null, price_yearly: null, custom_price_label: null,
  currency_symbol: '₹', price_note: '/ user / month', features: [], accent: '#0D9488',
  icon: 'rocket', badge: null, cta_label: 'Start free trial', cta_href: '/signup',
  display_order: 0, is_active: true,
};

export default function SitePlansTab() {
  const [rows, setRows] = useState<SitePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<SitePlan> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.from('site_plans').select('*').order('display_order');
    setLoadError(error ? error.message : null);
    setRows((data as SitePlan[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    setError(null);
    if (!editing.name?.trim()) { setError('Name is required.'); return; }
    const payload = {
      name: editing.name.trim(),
      tagline: editing.tagline?.trim() || null,
      price_monthly: editing.price_monthly != null && `${editing.price_monthly}` !== '' ? Number(editing.price_monthly) : null,
      price_yearly: editing.price_yearly != null && `${editing.price_yearly}` !== '' ? Number(editing.price_yearly) : null,
      custom_price_label: editing.custom_price_label?.trim() || null,
      currency_symbol: editing.currency_symbol?.trim() || '₹',
      price_note: editing.price_note?.trim() || '/ user / month',
      features: editing.features ?? [],
      accent: editing.accent?.trim() || '#0D9488',
      icon: editing.icon ?? 'rocket',
      badge: editing.badge?.trim() || null,
      cta_label: editing.cta_label?.trim() || 'Start free trial',
      cta_href: editing.cta_href?.trim() || '/signup',
      display_order: Number(editing.display_order ?? 0),
      is_active: editing.is_active ?? true,
      updated_at: new Date().toISOString(),
    };
    const { error } = editing.id
      ? await supabase.from('site_plans').update(payload).eq('id', editing.id)
      : await supabase.from('site_plans').insert(payload);
    if (error) setError(error.message);
    else { setEditing(null); await load(); }
  };

  const toggleActive = async (p: SitePlan) => {
    await supabase.from('site_plans').update({ is_active: !p.is_active, updated_at: new Date().toISOString() }).eq('id', p.id);
    await load();
  };

  const remove = async (p: SitePlan) => {
    const ok = await confirmDialog({
      title: `Delete the "${p.name}" card?`,
      body: 'It disappears from the public /pricing page immediately. This does NOT touch billing plans or existing licences.',
      confirmLabel: 'Delete card',
    });
    if (!ok) return;
    const { error } = await supabase.from('site_plans').delete().eq('id', p.id);
    if (error) notify.error('Could not delete card', { description: error.message });
    else { notify.success(`Card "${p.name}" deleted`); await load(); }
  };

  const priceLabel = (p: SitePlan) =>
    p.custom_price_label
      ? p.custom_price_label
      : `${p.currency_symbol}${Number(p.price_monthly ?? 0)} / ${p.currency_symbol}${Number(p.price_yearly ?? 0)}`;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500 max-w-2xl">
          These cards render on the public website's <span className="text-cyan-400">/pricing</span> page, in this order.
          They are display-only — checkout and licensing still use the billing plans in the other tab.
          Changes go live for visitors on their next page load.
        </p>
        <button
          onClick={() => setEditing({ ...EMPTY, display_order: (rows[rows.length - 1]?.display_order ?? 0) + 1 })}
          className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium whitespace-nowrap">
          + New Card
        </button>
      </div>

      {loadError && (
        <p className="text-amber-400 text-xs mb-3">
          Could not load website pricing cards: {loadError}
          {loadError.includes('site_plans') ? ' — has migration 0153_site_pricing_cards.sql been applied?' : ''}
        </p>
      )}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Order</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Price (mo / yr)</th>
              <th className="px-4 py-3 text-left">Badge</th>
              <th className="px-4 py-3 text-left">CTA</th>
              <th className="px-4 py-3 text-left">Accent</th>
              <th className="px-4 py-3 text-left">Active</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && !loadError && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">No cards yet — the website falls back to its built-in defaults until you add some.</td></tr>
            )}
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-gray-400">{p.display_order}</td>
                <td className="px-4 py-3 text-white">{p.name}</td>
                <td className="px-4 py-3 text-gray-300">{priceLabel(p)}</td>
                <td className="px-4 py-3">
                  {p.badge
                    ? <span className="px-2 py-0.5 text-[10px] rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">{p.badge}</span>
                    : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-400 text-xs">{p.cta_label} → <span className="font-mono text-cyan-400">{p.cta_href}</span></td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-2 text-xs text-gray-400">
                    <span className="w-4 h-4 rounded border border-dark-600" style={{ background: p.accent }} />
                    <span className="font-mono">{p.accent}</span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleActive(p)} className={`px-2 py-0.5 text-[10px] rounded-md border ${p.is_active ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30'}`}>
                    {p.is_active ? 'Active' : 'Hidden'}
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-3">
                    <button onClick={() => setEditing(p)} className="text-cyan-400 hover:text-cyan-300 text-xs">Edit</button>
                    <button onClick={() => remove(p)} className="text-rose-400 hover:text-rose-300 text-xs">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="w-full max-w-5xl max-h-[90vh] bg-dark-800 border border-dark-700 rounded-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-dark-700 flex items-center justify-between shrink-0">
              <h2 className="text-white font-semibold">{editing.id ? 'Edit Pricing Card' : 'New Pricing Card'}</h2>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-white">
                <i className="ri-close-line text-lg" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5">
                <section className="space-y-4">
                  <p className="text-[10px] uppercase tracking-wider text-cyan-400 font-medium">Card</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Name">
                      <input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={input} placeholder="Professional" />
                    </Field>
                    <Field label="Display order">
                      <input type="number" value={editing.display_order ?? 0}
                        onChange={(e) => setEditing({ ...editing, display_order: parseInt(e.target.value, 10) || 0 })} className={input} />
                    </Field>
                  </div>
                  <Field label="Tagline (under the name)">
                    <input value={editing.tagline ?? ''} onChange={(e) => setEditing({ ...editing, tagline: e.target.value })} className={input} placeholder="For teams that need deeper visibility." />
                  </Field>

                  <p className="text-[10px] uppercase tracking-wider text-cyan-400 font-medium pt-2">Pricing display</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Monthly price">
                      <input type="number" min={0} step="1" value={editing.price_monthly ?? ''}
                        onChange={(e) => setEditing({ ...editing, price_monthly: e.target.value === '' ? null : parseFloat(e.target.value) })} className={input} />
                    </Field>
                    <Field label="Yearly price (per month)">
                      <input type="number" min={0} step="1" value={editing.price_yearly ?? ''}
                        onChange={(e) => setEditing({ ...editing, price_yearly: e.target.value === '' ? null : parseFloat(e.target.value) })} className={input} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Currency symbol">
                      <input value={editing.currency_symbol ?? '₹'} onChange={(e) => setEditing({ ...editing, currency_symbol: e.target.value })} className={input} />
                    </Field>
                    <Field label="Price note">
                      <input value={editing.price_note ?? '/ user / month'} onChange={(e) => setEditing({ ...editing, price_note: e.target.value })} className={input} />
                    </Field>
                  </div>
                  <Field label={'Custom price label — overrides the numbers (e.g. "Custom pricing")'}>
                    <input value={editing.custom_price_label ?? ''} onChange={(e) => setEditing({ ...editing, custom_price_label: e.target.value || null })} className={input} placeholder="Leave empty to show the prices" />
                  </Field>

                  <p className="text-[10px] uppercase tracking-wider text-cyan-400 font-medium pt-2">Call to action</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Button label">
                      <input value={editing.cta_label ?? ''} onChange={(e) => setEditing({ ...editing, cta_label: e.target.value })} className={input} />
                    </Field>
                    <Field label="Button link">
                      <input value={editing.cta_href ?? ''} onChange={(e) => setEditing({ ...editing, cta_href: e.target.value })} className={input} placeholder="/signup or /contact" />
                    </Field>
                  </div>
                </section>

                <section className="space-y-4">
                  <p className="text-[10px] uppercase tracking-wider text-cyan-400 font-medium">Look</p>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Accent colour">
                      <div className="flex items-center gap-2">
                        <input type="color" value={editing.accent ?? '#0D9488'}
                          onChange={(e) => setEditing({ ...editing, accent: e.target.value })}
                          className="h-9 w-10 shrink-0 bg-dark-900 border border-dark-700 rounded-lg cursor-pointer p-1" />
                        <input value={editing.accent ?? '#0D9488'} onChange={(e) => setEditing({ ...editing, accent: e.target.value })} className={input} />
                      </div>
                    </Field>
                    <Field label="Icon">
                      <select value={editing.icon ?? 'rocket'} onChange={(e) => setEditing({ ...editing, icon: e.target.value as SitePlan['icon'] })} className={input}>
                        <option value="rocket">Rocket (starter)</option>
                        <option value="chart">Chart (growth)</option>
                        <option value="building">Building (enterprise)</option>
                      </select>
                    </Field>
                    <Field label="Badge (highlight banner)">
                      <input value={editing.badge ?? ''} onChange={(e) => setEditing({ ...editing, badge: e.target.value || null })} className={input} placeholder="MOST POPULAR" />
                    </Field>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    A card with a badge gets the coloured top banner, thick accent border and a solid-colour button — use it on exactly one card.
                  </p>

                  <Field label="Feature bullets — one per line, top to bottom">
                    <textarea
                      rows={10}
                      value={(editing.features ?? []).join('\n')}
                      onChange={(e) => setEditing({ ...editing, features: e.target.value.split('\n') })}
                      className={input}
                      placeholder={'Everything in Starter\nScreenshots\nLive screen view'}
                    />
                  </Field>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editing.is_active ?? true}
                      onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} className="accent-cyan-500" />
                    <span className="text-xs text-gray-200">Visible on the website</span>
                  </label>
                </section>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-dark-700 flex justify-end gap-2 shrink-0">
              <button onClick={() => setEditing(null)} className="px-4 py-2 text-xs rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300">Cancel</button>
              <button
                onClick={() => {
                  // Trim empty feature lines only on save, so typing newlines works.
                  setEditing((prev) => prev ? { ...prev, features: (prev.features ?? []).map((f) => f.trim()).filter(Boolean) } : prev);
                  setTimeout(save, 0);
                }}
                className="px-5 py-2 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium">
                Save Card
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
