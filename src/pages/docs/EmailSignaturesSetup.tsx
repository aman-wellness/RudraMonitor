// Public docs: setting up the Wellness Extract Outlook add-in in the
// customer's Microsoft 365 tenant. Same manifest URL for every customer —
// the backend routes signatures by UPN — but the install steps happen
// tenant-side, so the flow needs to live in the customer-facing docs
// (not just as a callout on the internal Email Signatures page).

import DocsLayout from './DocsLayout';

const MANIFEST_URL = 'https://ems.wellnessextract.com/outlook-addin/manifest.xml';

const SECTIONS = [
  { id: 'what',      label: '1. What this does' },
  { id: 'prereq',    label: '2. Prerequisites' },
  { id: 'install',   label: '3. Install the add-in' },
  { id: 'verify',    label: '4. Verify per user' },
  { id: 'troubleshoot', label: '5. Troubleshooting' },
  { id: 'security',  label: '6. Security notes' },
  { id: 'uninstall', label: '7. Uninstall' },
];

export default function EmailSignaturesSetup() {
  return (
    <DocsLayout
      title="Email Signatures — Outlook Add-in setup"
      subtitle="One-time, tenant-wide install so Outlook Web + New Outlook + Outlook Mobile pick up the signatures you push from Wellness Extract. Classic Outlook Desktop uses a separate agent-based path that needs no manual step."
      sections={SECTIONS}
      accent="cyan"
    >
      <article className="prose prose-invert max-w-4xl">

        <section id="what" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">1. What this does</h2>
          <p className="text-gray-300 text-sm mb-3">
            Modern Outlook Web (OWA) and the New Outlook client read signatures from
            Microsoft's Roaming Signatures store — a separate location from the
            legacy mailbox signature field. Microsoft has not shipped a stable
            Graph API to write that store yet, so no signature-management tool
            (ours, Exclaimer, CodeTwo, …) can push directly to OWA. Every product
            in this space solves it the same way:
          </p>
          <p className="text-gray-300 text-sm mb-3">
            <strong className="text-white">A tenant-wide Office Add-in</strong>
            {' '}quietly runs on each user's compose event. The add-in asks our
            signature service what the current user's signature is, and drops
            the HTML into the message body via <code className="text-emerald-300">Office.context.mailbox.item.body.setSignatureAsync()</code>.
          </p>
          <p className="text-gray-300 text-sm">
            One install per tenant. Every user who reads mail through OWA, New
            Outlook, or Outlook Mobile picks it up automatically — the same
            signature this dashboard pushes for their user.
          </p>
        </section>

        <section id="prereq" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">2. Prerequisites</h2>
          <ul className="text-gray-300 space-y-1.5 text-sm">
            <li>• A Microsoft 365 <strong>Global Administrator</strong> account for your tenant.</li>
            <li>• The <strong>Integrated apps</strong> feature enabled (default for Business Standard and up).</li>
            <li>• Users have Exchange Online mailboxes (the signature service reads UPN from Office context; on-prem-only Exchange isn't covered by this flow).</li>
            <li>• Outbound HTTPS from user mailboxes to <code className="text-emerald-300">ems.wellnessextract.com</code> and <code className="text-emerald-300">api-ems.wellnessextract.com</code> on port 443. No proxy allowlisting beyond those two hostnames.</li>
          </ul>
        </section>

        <section id="install" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">3. Install the add-in</h2>
          <p className="text-gray-300 text-sm mb-3">
            The manifest URL is <strong>the same for every Wellness Extract customer</strong> —
            our backend routes signatures by UPN, so a user in your tenant only
            ever receives the signature your admin pushed to them. Nothing about
            this URL is customer-specific.
          </p>

          <div className="mb-4 p-3 rounded-lg bg-dark-950 border border-dark-700">
            <p className="text-[10px] uppercase text-gray-500 mb-1.5">Add-in manifest URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1.5 bg-dark-800 border border-dark-700 rounded font-mono text-xs text-emerald-300 select-all break-all">
                {MANIFEST_URL}
              </code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(MANIFEST_URL)}
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
              >
                Copy
              </button>
            </div>
          </div>

          <ol className="text-gray-300 text-sm space-y-2.5 list-decimal ml-5">
            <li>Sign in to <a href="https://admin.microsoft.com/AdminPortal/Home#/Settings/IntegratedApps" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Microsoft 365 admin center → Settings → Integrated apps</a> with a Global Administrator account.</li>
            <li>Click <strong className="text-white">Upload custom apps</strong> at the top of the page.</li>
            <li>Under <em>App type</em>, choose <strong className="text-white">Office Add-in</strong>.</li>
            <li>Under <em>Choose how to upload app</em>, pick <strong className="text-white">Provide link to manifest file</strong>.</li>
            <li>Paste the manifest URL from the box above and click <strong className="text-white">Validate</strong>. You should see "Manifest validated successfully."</li>
            <li>Click <strong>Next</strong>. On the <em>Assign users</em> step, choose <strong className="text-white">Entire organization</strong> (or a specific security group if you want a pilot).</li>
            <li>Confirm the requested permissions:
              <ul className="ml-5 mt-1 text-xs text-gray-400 space-y-0.5">
                <li>• Read and write your mail (needed to insert the signature)</li>
                <li>• Run in an event handler on new message / reply / forward</li>
              </ul>
            </li>
            <li>Click <strong>Deploy</strong>. Microsoft says allow up to 12 h for rollout; in practice most tenants see the add-in in ~30 minutes.</li>
          </ol>

          <div className="mt-4 p-3 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs">
            <strong>Tip:</strong> If you're piloting on a small group first, assign the add-in to a
            security group with 2–3 mailboxes, verify per user (below), then re-open the
            add-in in Integrated apps → <em>Edit users and groups</em> and expand to the
            whole organisation.
          </div>
        </section>

        <section id="verify" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">4. Verify per user</h2>

          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-4 text-sm text-amber-100">
            <p className="font-semibold mb-1">Do NOT check OWA <em>Settings → Account → Signatures</em> — it will always show "No signature yet".</p>
            <p className="text-amber-100/80 text-xs leading-relaxed">
              That panel manages OWA's native <strong>Roaming Signatures</strong> store, which no third-party add-in
              (ours, Exclaimer, CodeTwo, …) can write to — Microsoft has not shipped a Graph API for it yet. Our
              add-in instead injects the signature <strong>into the compose body when the user clicks "New mail"</strong>.
              The correct verification is to compose a new message and look at the body — never the Signatures panel.
            </p>
          </div>

          <ol className="text-gray-300 text-sm space-y-2 list-decimal ml-5">
            <li>Wait ~30 minutes after Deploy (Microsoft's rollout window — occasionally up to 6 h for a brand-new install).</li>
            <li>Sign in to a target user's OWA at <a href="https://outlook.office.com" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">outlook.office.com</a>. Click <strong>New mail</strong>.</li>
            <li>The signature should appear in the <strong>compose body</strong> within 1-2 s after the empty draft loads. This is where you verify — not the Signatures panel.</li>
            <li>Repeat for <em>Reply</em> and <em>Forward</em> — the same launch event covers all three.</li>
            <li>In the Wellness Extract dashboard's <em>Email Signatures</em> page, click <strong>Verify</strong> on the user's row: the Exchange-side signature should show as "Stored" (that's what Classic Outlook Desktop reads).</li>
          </ol>
        </section>

        <section id="troubleshoot" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">5. Troubleshooting</h2>
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-white font-medium">"Upload failed. Please check the manifest file and try again."</p>
              <p className="text-gray-400 mt-1 text-xs leading-relaxed">
                Almost always a network issue reaching the manifest URL — proxy, tenant egress filter, or a stale DNS. Try opening the URL in a browser tab from the same machine as the admin center session. If the browser can fetch the XML (starts with <code className="text-gray-300">&lt;?xml version="1.0"</code>), rebuild the admin center session and retry. The manifest is served with Content-Type <code className="text-gray-300">text/xml</code> and Access-Control-Allow-Origin <code className="text-gray-300">*</code>, so cross-origin isn't the cause.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Add-in deployed but OWA compose is empty</p>
              <p className="text-gray-400 mt-1 text-xs leading-relaxed">
                Give Microsoft's rollout the full 12 h before declaring the deploy stuck. Then reload OWA from the ...→ Settings menu with Ctrl+F5 to clear the local add-in cache. If it's still empty, check the Wellness Extract dashboard: <em>Email Signatures</em> → the user's row → <strong>Verify</strong>. If Exchange DOES have the signature stored, the add-in either isn't running for that user (check Integrated apps' assignment scope) or hasn't rolled out yet.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Signature appears once, then blank on the next email</p>
              <p className="text-gray-400 mt-1 text-xs leading-relaxed">
                Modern Outlook caches the LaunchEvent runtime; a user who typed their own signature in Outlook Settings sees it override ours. In OWA → Settings → Mail → Compose and reply → Signatures, delete any user-created signature entries, then compose a new message. The add-in signature will inject on the next event.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Signature works in OWA but not in Outlook Mobile</p>
              <p className="text-gray-400 mt-1 text-xs leading-relaxed">
                Outlook Mobile picks up event-based add-ins on iOS 16.4+ / Android 13+. Older mobile clients can't run our add-in at all; users on those need to set the signature manually once (Outlook mobile → Settings → Signature).
              </p>
            </div>
          </div>
        </section>

        <section id="security" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">6. Security notes for your compliance team</h2>
          <ul className="text-gray-300 space-y-1.5 text-sm">
            <li>• The add-in runs <strong>only</strong> on New Message / Reply / Forward compose events. It does not run on message read, on send, or in the background.</li>
            <li>• It reads a single value from Office context: the composing user's UPN. It does not read the message subject, recipients, body, or any other user data.</li>
            <li>• It makes exactly one outbound call: <code className="text-emerald-300">GET https://api-ems.wellnessextract.com/functions/v1/outlook-addin-signature?upn=&lt;their upn&gt;</code>. The response is the rendered HTML signature.</li>
            <li>• The rendered HTML is dropped into the message body via the Office.js <code className="text-emerald-300">setSignatureAsync</code> API, which is Microsoft's official channel for this and is auditable in Message Trace like any other outgoing content.</li>
            <li>• No mailbox data leaves the tenant. The service does not have delegated mailbox permissions; the add-in itself has <code className="text-emerald-300">ReadWriteMailbox</code> only as a manifest requirement, but only exercises write on the one composing message.</li>
            <li>• Manifest source is publicly reviewable at <a href={MANIFEST_URL} className="text-cyan-400 hover:underline">{MANIFEST_URL}</a> and the JavaScript at <a href="https://ems.wellnessextract.com/outlook-addin/commands.js" className="text-cyan-400 hover:underline">/outlook-addin/commands.js</a>.</li>
          </ul>
        </section>

        <section id="uninstall" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">7. Uninstall</h2>
          <ol className="text-gray-300 text-sm space-y-1.5 list-decimal ml-5">
            <li>Microsoft 365 admin center → Settings → Integrated apps.</li>
            <li>Locate <em>Wellness Extract Signature</em> in the list.</li>
            <li>Click the entry → <strong>Remove app</strong>.</li>
            <li>Existing composed drafts still show the signature; new drafts stop getting it immediately after the removal propagates (usually under 15 minutes).</li>
          </ol>
        </section>
      </article>
    </DocsLayout>
  );
}
