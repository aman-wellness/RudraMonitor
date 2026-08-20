// Wellness Extract signature add-in — event-based signature injection.
//
// Fires on OnNewMessageComposeHandler, OnMessageReplyHandler, OnMessageForwardHandler.
// For each event we fetch the user's rendered signature from the portal and
// call Office.context.mailbox.item.body.setSignatureAsync() to inject it into
// the compose window. Users see the signature immediately, ready to send.
//
// IMPORTANT: `event.completed()` MUST be called on every code path (success
// AND failure) or Outlook thinks the handler is still running and blocks
// subsequent events. All fetch failures are swallowed to keep Outlook happy.

const API_BASE = "https://api-ems.wellnessextract.com";
// Public anon key — safe to embed in client-side code (all RLS still applies).
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0amF6YXhqaHp2cnpocHRycG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzU2OTcsImV4cCI6MjA5MzcxMTY5N30.kkXP6bhbjpuCz-Da77v3hFYEc3NQ6fJEgP-I1uHZK1E";

Office.onReady();

async function fetchSignature(upn) {
  const url = `${API_BASE}/functions/v1/outlook-addin-signature?upn=${encodeURIComponent(upn)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function injectSignature(event) {
  const upn = Office.context.mailbox.userProfile.emailAddress;

  // Retrieve the signature from our portal.
  fetchSignature(upn)
    .then((data) => {
      if (!data || !data.enabled || !data.html) {
        event.completed();
        return;
      }
      // setSignatureAsync replaces any existing default signature Outlook
      // was about to auto-attach and inserts ours at the correct location
      // in the compose body (respecting reply quote position, forward marker,
      // etc.). This is the Microsoft-blessed API for signature injection.
      Office.context.mailbox.item.body.setSignatureAsync(
        data.html,
        { coercionType: Office.CoercionType.Html },
        (res) => {
          if (res.status !== Office.AsyncResultStatus.Succeeded) {
            console.warn("setSignatureAsync failed:", res.error && res.error.message);
          }
          event.completed();
        },
      );
    })
    .catch((err) => {
      console.warn("signature fetch failed:", err && err.message);
      event.completed();
    });
}

// Handler registrations — names MUST match the FunctionName values in
// manifest.xml <LaunchEvent> nodes.
function onNewMessageComposeHandler(event) { injectSignature(event); }
function onMessageReplyHandler(event)      { injectSignature(event); }
function onMessageForwardHandler(event)    { injectSignature(event); }

// Office 1.10+ event-based add-ins require associations on the runtime.
Office.actions.associate("onNewMessageComposeHandler", onNewMessageComposeHandler);
Office.actions.associate("onMessageReplyHandler",      onMessageReplyHandler);
Office.actions.associate("onMessageForwardHandler",    onMessageForwardHandler);
