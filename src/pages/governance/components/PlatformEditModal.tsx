import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import ModalShell from './ModalShell';
import type { GovPillar, GovPillarPlatform } from '../types';

interface CredentialOption {
  id: string;
  platform_name: string;
  category: string | null;
  username: string | null;
  active: boolean;
}

interface Props {
  platform: Partial<GovPillarPlatform> | null;     // null = new
  pillars: GovPillar[];
  defaultPillarId?: string;
  onSaved: () => void;
  onClose: () => void;
}

export default function PlatformEditModal({ platform, pillars, defaultPillarId, onSaved, onClose }: Props) {
  const [pillarId, setPillarId] = useState(platform?.pillar_id ?? defaultPillarId ?? pillars[0]?.id ?? '');
  const [name, setName] = useState(platform?.platform_name ?? '');
  const [type, setType] = useState(platform?.platform_type ?? '');
  const [accessMethod, setAccessMethod] = useState(platform?.access_method ?? '');
  const [email, setEmail] = useState(platform?.ownership_email ?? '');
  const [itRegistered, setItRegistered] = useState<boolean>(platform?.it_registered ?? false);
  const [credentialId, setCredentialId] = useState<string | null>(platform?.credential_id ?? null);
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull available credentials from the existing vault so user can link this
  // governance platform to a real credential entry (rotated passwords, OTP
  // channels, billing, etc. live there).
  useEffect(() => {
    supabase.from('credentials_safe')
      .select('id, platform_name, category, username, active')
      .eq('active', true)
      .order('platform_name')
      .then(({ data }) => setCredentials((data ?? []) as CredentialOption[]));
  }, []);

  // When user picks a credential, auto-fill the name + type (saves typing).
  const handlePickCredential = (id: string | null) => {
    setCredentialId(id);
    if (!id) return;
    const c = credentials.find((x) => x.id === id);
    if (c && !name) setName(c.platform_name);
    if (c?.category && !type) setType(c.category);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gov-platform-save`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        id: platform?.id ?? undefined,
        pillar_id: pillarId,
        platform_name: name,
        platform_type: type || null,
        access_method: accessMethod || null,
        ownership_email: email || null,
        it_registered: itRegistered,
        credential_id: credentialId,
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

  return (
    <ModalShell
      title={platform?.id ? `Edit ${platform.platform_name}` : 'Add platform'}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !name || !pillarId}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-dark-900 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save platform'}
          </button>
        </>
      )}
    >
      {error && <div className="mb-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}

      <div className="space-y-4 text-sm">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Pillar *</label>
          <select
            value={pillarId}
            onChange={(e) => setPillarId(e.target.value)}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
          >
            {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Platform name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Amazon Seller Central"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Type</label>
            <input
              value={type ?? ''}
              onChange={(e) => setType(e.target.value)}
              placeholder="Marketplace"
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Access method</label>
            <input
              value={accessMethod ?? ''}
              onChange={(e) => setAccessMethod(e.target.value)}
              placeholder="Direct + Agency MCC link"
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Ownership email</label>
          <input
            value={email ?? ''}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="amazon@rudrans.com"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white font-mono"
          />
        </div>
        {/* Link to existing credential — auto-fills name + type */}
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
          <label className="block text-[10px] uppercase tracking-wider text-blue-300 mb-2 font-semibold">
            <i className="ri-link mr-1" /> Link to Credentials Vault (optional)
          </label>
          <select
            value={credentialId ?? ''}
            onChange={(e) => handlePickCredential(e.target.value || null)}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm"
          >
            <option value="">— No link —</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.platform_name}{c.category ? ` · ${c.category}` : ''}{c.username ? ` (${c.username})` : ''}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-blue-300/70 mt-2">
            Linking surfaces real passwords, OTP channels, and billing from <a href="/employees/credentials" className="underline">Credentials Vault</a> in this platform card.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={itRegistered} onChange={(e) => setItRegistered(e.target.checked)} />
          IT has registered this platform under the shared ownership email.
        </label>
      </div>
    </ModalShell>
  );
}
