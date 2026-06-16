import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

// Pushes a single org-wide wallpaper image to every agent that has
// `wallpaper_enforced = true`. Agents poll agent-settings every 60 s and
// re-apply when `wallpaper_updated_at` advances.
//
// Path convention in bucket: <org_id>/wallpaper-<timestamp>.jpg
// The agent-side downloader doesn't care about the filename — it just
// fetches whatever `wallpaper_url` resolves to.
export default function WallpaperUploadCard() {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    void refresh();
  }, [orgId]);

  const refresh = async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('organization_settings')
      .select('wallpaper_url, wallpaper_updated_at')
      .eq('org_id', orgId)
      .maybeSingle();
    setCurrentUrl((data?.wallpaper_url as string | null) ?? null);
    setUpdatedAt((data?.wallpaper_updated_at as string | null) ?? null);
  };

  const handleUpload = async (file: File) => {
    if (!orgId) return;
    setError(null);
    setUploading(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or less');
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        throw new Error('Only JPEG or PNG allowed');
      }

      const ext = file.type === 'image/png' ? 'png' : 'jpg';
      const path = `${orgId}/wallpaper-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('wallpapers')
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;

      // Public bucket — build a stable URL the agent can fetch without auth.
      const { data: pub } = supabase.storage.from('wallpapers').getPublicUrl(path);

      const { error: upsertErr } = await supabase
        .from('organization_settings')
        .upsert(
          {
            org_id: orgId,
            wallpaper_url: pub.publicUrl,
            wallpaper_updated_at: new Date().toISOString(),
          },
          { onConflict: 'org_id' },
        );
      if (upsertErr) throw upsertErr;

      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    if (!orgId) return;
    if (!confirm('Remove the org wallpaper? Agents will keep whatever wallpaper they currently have — they won\'t revert to the original.')) return;
    setBusy(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from('organization_settings')
        .upsert(
          { org_id: orgId, wallpaper_url: null, wallpaper_updated_at: null },
          { onConflict: 'org_id' },
        );
      if (upErr) throw upErr;
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-5 h-5 flex items-center justify-center">
          <i className="ri-image-2-line text-indigo-400 text-sm" />
        </span>
        <h3 className="text-sm font-semibold text-white">Org Wallpaper</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">
        Upload a JPEG or PNG (≤ 5 MB). It auto-applies to every agent within ~1 minute.
        Agents with the per-device "Apply org wallpaper" toggle OFF are exempt.
      </p>

      {currentUrl ? (
        <div className="mb-4">
          <div className="aspect-video w-full max-w-md rounded-lg overflow-hidden border border-dark-700 bg-dark-900">
            <img src={currentUrl} alt="Current org wallpaper" className="w-full h-full object-cover" />
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            Last updated: {updatedAt ? new Date(updatedAt).toLocaleString() : '—'}
          </p>
        </div>
      ) : (
        <div className="mb-4 aspect-video w-full max-w-md rounded-lg border border-dashed border-dark-700 bg-dark-900 flex items-center justify-center">
          <p className="text-xs text-gray-500">No wallpaper set</p>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
          uploading ? 'bg-dark-700 text-gray-500 cursor-wait' : 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/25 hover:bg-indigo-500/25'
        }`}>
          {uploading ? 'Uploading…' : currentUrl ? 'Replace wallpaper' : 'Upload wallpaper'}
          <input
            type="file"
            accept="image/jpeg,image/png"
            disabled={uploading}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = '';
            }}
          />
        </label>
        {currentUrl && (
          <button
            onClick={handleRemove}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-dark-900 border border-dark-700 text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-50"
          >
            {busy ? 'Removing…' : 'Remove wallpaper'}
          </button>
        )}
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <i className="ri-check-line" />
            Saved — agents apply within 1 min
          </span>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
