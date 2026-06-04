import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import ModalShell from './ModalShell';
import type { GovPolicy } from '../types';

interface Props {
  policy: Partial<GovPolicy> | null;
  onSaved: () => void;
  onClose: () => void;
}

export default function PolicyEditModal({ policy, onSaved, onClose }: Props) {
  const [code, setCode] = useState(policy?.code ?? '');
  const [body, setBody] = useState(policy?.body ?? '');
  const [enforcedBy, setEnforcedBy] = useState(policy?.enforced_by ?? 'IT');
  const [sortOrder, setSortOrder] = useState(policy?.sort_order ?? 100);
  const [isActive, setIsActive] = useState<boolean>(policy?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-policy-save`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        id: policy?.id ?? undefined,
        code: code || undefined,
        body,
        enforced_by: enforcedBy || null,
        sort_order: sortOrder,
        is_active: isActive,
      }),
    });
    const res_body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(res_body?.error ?? `HTTP ${res.status}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={policy?.id ? `Edit ${policy.code}` : 'New policy'}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !body || (!policy?.id && !code)}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </>
      )}
    >
      {error && <div className="mb-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Code *</label>
            <input
              value={code}
              disabled={!!policy?.id}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="P09"
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white font-mono disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Enforced by</label>
            <input
              value={enforcedBy ?? ''}
              onChange={(e) => setEnforcedBy(e.target.value)}
              placeholder="IT"
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
            />
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
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Body *</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="All platform access is assigned to individual company email IDs…"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white resize-y"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (visible in the published policy list).
        </label>
      </div>
    </ModalShell>
  );
}
