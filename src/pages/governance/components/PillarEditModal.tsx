import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import ModalShell from './ModalShell';
import type { GovPillar, GovPillarStatus } from '../types';

interface Props {
  pillar: Partial<GovPillar> | null;     // null = creating new
  allPillars: GovPillar[];                // for "reports to" picker
  onSaved: () => void;
  onClose: () => void;
}

const COLOR_SWATCHES = ['#2563a8', '#8a5c0e', '#5535a0', '#176044', '#155e6b', '#8f1f1f', '#444444', '#5e3a8c', '#2a2a2a'];

const STATUSES: GovPillarStatus[] = ['filled', 'hiring', 'vacant', 'archived'];

export default function PillarEditModal({ pillar, allPillars, onSaved, onClose }: Props) {
  const [code, setCode] = useState(pillar?.code ?? '');
  const [name, setName] = useState(pillar?.name ?? '');
  const [color, setColor] = useState(pillar?.color ?? '#444444');
  const [funcsDesc, setFuncsDesc] = useState(pillar?.functions_desc ?? '');
  const [reportsTo, setReportsTo] = useState<string | null>(pillar?.reports_to_pillar_id ?? null);
  const [hiringFlag, setHiringFlag] = useState<boolean>(pillar?.hiring_flag ?? false);
  const [status, setStatus] = useState<GovPillarStatus>(pillar?.status ?? 'filled');
  const [sortOrder, setSortOrder] = useState(pillar?.sort_order ?? 100);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-pillar-save`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        id: pillar?.id ?? undefined,
        code: code || undefined,
        name,
        color,
        functions_desc: funcsDesc || null,
        reports_to_pillar_id: reportsTo,
        hiring_flag: hiringFlag,
        status,
        sort_order: sortOrder,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body?.error ?? `HTTP ${res.status}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
    onClose();
  };

  const isNew = !pillar?.id;
  const editableCode = isNew;       // codes are immutable after creation

  return (
    <ModalShell
      title={isNew ? 'New pillar' : `Edit ${pillar?.name ?? 'pillar'}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !name}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save pillar'}
          </button>
        </>
      )}
    >
      {error && <div className="mb-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}

      <div className="space-y-4 text-sm">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. SEO"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Code (slug) {editableCode ? '*' : '— immutable'}
          </label>
          <input
            value={code}
            disabled={!editableCode}
            onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="seo"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white font-mono disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Functions / Description</label>
          <input
            value={funcsDesc}
            onChange={(e) => setFuncsDesc(e.target.value)}
            placeholder="Organic search · Technical SEO · Content strategy"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as GovPillarStatus)}
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Sort order</label>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Reports to</label>
          <select
            value={reportsTo ?? ''}
            onChange={(e) => setReportsTo(e.target.value || null)}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
          >
            <option value="">Founder (root)</option>
            {allPillars.filter((p) => p.id !== pillar?.id).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-2">Color</label>
          <div className="flex gap-2 flex-wrap">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full border-2 ${color === c ? 'border-white' : 'border-dark-700'}`}
                style={{ background: c }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={hiringFlag}
            onChange={(e) => setHiringFlag(e.target.checked)}
          />
          This pillar's lead seat is currently <strong>hiring</strong> — flag in the org chart with the amber pill.
        </label>
      </div>
    </ModalShell>
  );
}
