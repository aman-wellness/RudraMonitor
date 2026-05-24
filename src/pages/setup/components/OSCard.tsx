import { useState } from 'react';

interface DownloadItem {
  label: string;
  filename: string;
  url: string;
  size: string;
  version: string;
}

interface Props {
  os: string;
  icon: string;
  color: string;
  borderColor: string;
  bgColor: string;
  downloads: DownloadItem[];
  minVersion: string;
  arch: string;
  steps: string[];
}

export default function OSCard({ os, icon, color, borderColor, bgColor, downloads, minVersion, arch, steps }: Props) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showCopied, setShowCopied] = useState(false);

  const handleDownload = (dl: DownloadItem) => {
    if (!dl.url) return;
    setDownloading(dl.filename);
    // Trigger an actual download by clicking a hidden anchor with the `download` attr.
    // Using `<a>` instead of `window.location` so multi-file downloads stay independent
    // and the browser uses the suggested filename.
    const a = document.createElement('a');
    a.href = dl.url;
    a.download = dl.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => setDownloading(null), 1500);
  };

  const copyCommand = () => {
    if (os === 'Ubuntu') {
      navigator.clipboard.writeText('wget -qO- https://rudrans.com/install.sh | sudo bash');
    } else {
      navigator.clipboard.writeText('https://rudrans.com/download');
    }
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  return (
    <div className={`bg-dark-800 border ${borderColor} rounded-xl overflow-hidden transition-all duration-300 hover:scale-[1.01]`}>
      {/* Header */}
      <div className={`${bgColor} px-5 py-4 flex items-center gap-3 border-b ${borderColor}`}>
        <span className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center`}>
          <i className={`${icon} text-xl ${color}`} />
        </span>
        <div>
          <h3 className="text-white font-poppins font-semibold text-sm">{os}</h3>
          <p className="text-xs text-gray-500">Min. {minVersion} &middot; {arch}</p>
        </div>
      </div>

      {/* Downloads */}
      <div className="px-5 py-4 space-y-3">
        {downloads.map((dl) => (
          <div key={dl.filename} className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-300 font-medium truncate">{dl.label}</p>
              <p className="text-[11px] text-gray-600 mt-0.5">v{dl.version} &middot; {dl.size}</p>
            </div>
            <button
              onClick={() => handleDownload(dl)}
              disabled={!dl.url || downloading === dl.filename}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex items-center gap-1.5 transition-all ${
                !dl.url
                  ? 'bg-dark-700 text-gray-600 cursor-not-allowed border border-dark-700'
                  : downloading === dl.filename
                    ? 'bg-dark-700 text-gray-400 cursor-not-allowed'
                    : `bg-dark-700 ${color} hover:bg-dark-600 border border-dark-600`
              }`}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center">
                {downloading === dl.filename ? (
                  <i className="ri-loader-4-line animate-spin text-xs" />
                ) : (
                  <i className="ri-download-line text-xs" />
                )}
              </span>
              {!dl.url ? 'Unavailable' : downloading === dl.filename ? 'Starting…' : 'Download'}
            </button>
          </div>
        ))}
      </div>

      {/* Quick Install Command */}
      <div className="px-5 pb-4">
        <div className="bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-gray-500 font-medium">Quick Install</span>
            <button
              onClick={copyCommand}
              className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
            >
              <span className="w-3 h-3 flex items-center justify-center">
                <i className={`${showCopied ? 'ri-check-line' : 'ri-file-copy-line'} text-xs`} />
              </span>
              {showCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-[11px] text-gray-400 font-mono block break-all">
            {os === 'Ubuntu'
              ? 'wget -qO- https://rudrans.com/install.sh | sudo bash'
              : os === 'macOS'
                ? 'xattr -dr com.apple.quarantine ~/Downloads/Security-Assistant-macOS-*.pkg'
                : 'msiexec /i SecurityAssistant.msi /quiet /norestart'}
          </code>
          {os === 'macOS' && (
            <p className="text-[10px] text-amber-300 mt-2 leading-relaxed">
              <i className="ri-error-warning-line" /> Run this command FIRST in Terminal to clear the Gatekeeper quarantine flag.
              Then double-click the .pkg. Without this, macOS Sequoia (15+) will block the installer.
            </p>
          )}
        </div>
      </div>

      {/* Install Steps */}
      <div className="px-5 pb-5">
        <p className="text-[11px] text-gray-500 font-medium mb-2.5">Installation Steps</p>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className={`w-5 h-5 rounded-full ${bgColor} ${color} flex items-center justify-center flex-shrink-0 mt-px text-[10px] font-bold`}>
                {i + 1}
              </span>
              <p className="text-xs text-gray-400 leading-relaxed">{step}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}