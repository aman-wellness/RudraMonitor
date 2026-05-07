import { useEffect, useState } from 'react';

interface Props {
  screenshotsEnabled: boolean;
  videosEnabled: boolean;
  onUpdate: (screenshots: boolean, videos: boolean) => Promise<void> | void;
}

export default function CaptureControls({ screenshotsEnabled, videosEnabled, onUpdate }: Props) {
  const [ss, setSs] = useState(screenshotsEnabled);
  const [vid, setVid] = useState(videosEnabled);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local state when props change (e.g. agent-detail refreshes after a write).
  useEffect(() => { setSs(screenshotsEnabled); }, [screenshotsEnabled]);
  useEffect(() => { setVid(videosEnabled); }, [videosEnabled]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await onUpdate(ss, vid);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = ss !== screenshotsEnabled || vid !== videosEnabled;

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-5 h-5 flex items-center justify-center">
          <i className="ri-camera-line text-emerald-400 text-sm" />
        </span>
        <h3 className="text-sm font-semibold text-white">Capture Controls</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">Enable or disable screen recording features for this agent. Changes apply immediately on the next heartbeat.</p>

      <div className="space-y-3">
        {/* Screenshot Toggle */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${ss ? 'bg-emerald-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-image-line ${ss ? 'text-emerald-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Screenshots</p>
              <p className="text-[11px] text-gray-500">Capture on activity change & URL change</p>
            </div>
          </div>
          <button
            onClick={() => setSs(!ss)}
            className={`w-10 h-5 rounded-full transition-colors relative ${ss ? 'bg-emerald-500' : 'bg-dark-700'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${ss ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>

        {/* Video Toggle */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${vid ? 'bg-emerald-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-video-line ${vid ? 'text-emerald-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Video Recording</p>
              <p className="text-[11px] text-gray-500">10-min clips every interval</p>
            </div>
          </div>
          <button
            onClick={() => setVid(!vid)}
            className={`w-10 h-5 rounded-full transition-colors relative ${vid ? 'bg-emerald-500' : 'bg-dark-700'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${vid ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dark-700">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-check-line text-xs" /></span>
            Saved — agent picks up within 5 min
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            hasChanges && !saving
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25'
              : 'bg-dark-700 text-gray-500 cursor-not-allowed border border-dark-700'
          }`}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}