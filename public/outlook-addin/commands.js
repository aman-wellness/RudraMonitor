// Wellness Extract signature add-in — event-based signature injection.
//
// Fires on OnNewMessageComposeHandler (see manifest.xml). We fetch the user's
// rendered signature from the portal and call
// Office.context.mailbox.item.body.setSignatureAsync() to inject it into the
// compose window. Users see the signature immediately, ready to send.
//
// IMPORTANT: `event.completed()` MUST be called on every code path (success
// AND failure) or Outlook thinks the handler is still running and blocks
// subsequent events. All fetch/inject failures are swallowed so Outlook is
// never left waiting.

const API_BASE = "https://api-ems.wellnessextract.com";
// Public anon key — safe to embed in client-side code (all RLS still applies).
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0amF6YXhqaHp2cnpocHRycG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzU2OTcsImV4cCI6MjA5MzcxMTY5N30.kkXP6bhbjpuCz-Da77v3hFYEc3NQ6fJEgP-I1uHZK1E";

function log(msg, extra) {
  try { console.log("[WE-Signature] " + msg, extra ?? ""); } catch (_) {}
}

async function fetchSignature(upn) {
  const url = API_BASE + "/functions/v1/outlook-addin-signature?upn=" + encodeURIComponent(upn);
  log("fetching", url);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "apikey": ANON_KEY,
      "Authorization": "Bearer " + ANON_KEY,
    },
  });
  log("fetch status", resp.status);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

function injectSignature(event) {
  log("handler fired");
  let upn = "";
  try {
    upn = Office.context.mailbox.userProfile.emailAddress || "";
  } catch (err) {
    log("mailbox unavailable", err && err.message);
    event.completed();
    return;
  }
  log("upn", upn);

  fetchSignature(upn)
    .then((data) => {
      log("fetch ok", { enabled: data && data.enabled, hasHtml: !!(data && data.html) });
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
          log("setSignatureAsync result", res && res.status);
          if (res.status !== Office.AsyncResultStatus.Succeeded) {
            log("setSignatureAsync error", res.error && res.error.message);
          }
          event.completed();
        },
      );
    })
    .catch((err) => {
      log("fetch failed", err && err.message);
      event.completed();
    });
}

// Handler MUST be associated at module load, BEFORE Office.onReady resolves.
// Microsoft's LaunchEvent runtime looks up the FunctionName from manifest.xml
// against the associate registry the moment the event fires; if we register
// inside an Office.onReady callback we lose an inevitable race.
Office.actions.associate("onNewMessageComposeHandler", injectSignature);
log("associate registered");
