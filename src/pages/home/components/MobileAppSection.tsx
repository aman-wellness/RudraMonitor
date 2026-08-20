// "Get the mobile app" section for the landing page.
//
// Two download paths surfaced side-by-side:
//   • Android — direct signed APK download (.apk file)
//   • iOS    — PWA "Add to Home Screen" via Safari (no App Store, no Xcode)
//
// Native iOS App Store build is parked until we cross the customer
// threshold that justifies the $99/yr Apple Developer fee.

import { useMemo } from 'react';

// Both assets live on the dashboard subdomain (ems.wellnessextract.com) — that's
// the EC2 nginx where we rsync the APK + serve the PWA. The marketing
// domain (ems.wellnessextract.com) is a different vhost / static site, so relative
// URLs from `window.location.origin` would 404 on the marketing pages.
// Hard-code the dashboard host instead.
const APP_HOST = 'https://ems.wellnessextract.com';
// APK is published to the Supabase storage `releases` bucket by the
// build-mobile-apk.yml CI workflow on every push to main with
// mobile/** changes. The `-latest-debug.apk` filename is stable across
// versions so this URL never goes stale — newest build always wins.
const APK_URL = 'https://api-ems.wellnessextract.com/storage/v1/object/public/releases/Wellness-Extract-Invoice-latest-debug.apk';

export default function MobileAppSection() {
  const apkUrl = APK_URL;
  const pwaUrl = `${APP_HOST}/m/`;
  const isIos = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent), []);
  const isAndroid = useMemo(() => /Android/i.test(navigator.userAgent), []);

  return (
    <section id="mobile-app" className="py-12 md:py-20 px-4 bg-dark-950">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 text-xs font-medium mb-3">
            <i className="ri-smartphone-line mr-1" /> Mobile app · live
          </span>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Snap invoices on the go
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-sm md:text-base">
            Field admins point the phone camera at any invoice — Claude reads it,
            auto-fills the fields, and saves into your accounts pipeline.
            No scanner, no laptop, no email-to-self.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {/* Android card */}
          <div className={`bg-dark-800 border rounded-2xl p-6 ${isAndroid ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-dark-700'}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                <i className="ri-android-fill text-2xl text-emerald-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-lg">Android</h3>
                <p className="text-xs text-gray-400">7 MB · APK direct install</p>
              </div>
              {isAndroid && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-emerald-300 bg-emerald-500/15 px-2 py-1 rounded-full">
                  Your device
                </span>
              )}
            </div>

            <ol className="text-sm text-gray-300 space-y-2 mb-5 pl-4 list-decimal">
              <li>Tap the download button below — APK lands in your Downloads folder.</li>
              <li>Open the file → Android will ask "Allow install from this source?" → <span className="text-emerald-300">Allow</span>.</li>
              <li>Install → open <strong>Wellness Extract Invoice</strong> → sign in with your dashboard email.</li>
            </ol>

            <a
              href={apkUrl}
              className="inline-flex items-center justify-center w-full gap-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold py-3 px-4 rounded-xl transition"
            >
              <i className="ri-download-cloud-2-line text-lg" />
              Download APK
            </a>
            <p className="text-[10px] text-gray-500 text-center mt-2">
              Not on Play Store yet — this is a direct install for internal admins.
            </p>
          </div>

          {/* iOS card */}
          <div className={`bg-dark-800 border rounded-2xl p-6 ${isIos ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-dark-700'}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-blue-500/15 flex items-center justify-center">
                <i className="ri-apple-fill text-2xl text-blue-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-lg">iPhone / iPad</h3>
                <p className="text-xs text-gray-400">No App Store · runs in Safari</p>
              </div>
              {isIos && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-emerald-300 bg-emerald-500/15 px-2 py-1 rounded-full">
                  Your device
                </span>
              )}
            </div>

            <ol className="text-sm text-gray-300 space-y-2 mb-5 pl-4 list-decimal">
              <li>
                Open on iPhone <strong>Safari</strong> (not Chrome):{' '}
                <a href={pwaUrl} className="text-blue-300 underline break-all">{pwaUrl}</a>
              </li>
              <li>
                Tap <i className="ri-share-forward-line mx-1" /> Share → <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Home screen pe Wellness Extract Invoice icon aa jayega — full-screen, app jaisa.
              </li>
            </ol>

            <a
              href={pwaUrl}
              className="inline-flex items-center justify-center w-full gap-2 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 font-semibold py-3 px-4 rounded-xl transition"
            >
              <i className="ri-safari-line text-lg" />
              Open mobile app
            </a>
            <p className="text-[10px] text-gray-500 text-center mt-2">
              Works offline-light. Native iOS app coming when we cross the App Store threshold.
            </p>
          </div>
        </div>

        <div className="text-center mt-10">
          <p className="text-xs text-gray-500 max-w-xl mx-auto">
            Sign in with your existing Wellness Extract dashboard email + password.
            The mobile app uploads invoices to <strong className="text-gray-300">your organisation</strong>;
            you can switch orgs at any time from Account → Switch organisation.
          </p>
        </div>
      </div>
    </section>
  );
}
