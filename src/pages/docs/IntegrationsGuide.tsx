// Step-by-step setup guide for every external platform Wellness Extract can talk to.
// Linked from the landing page footer + DocsLayout top nav. Each platform
// section is self-contained — customers should be able to land on
// /docs/integrations#slack (or any other anchor) and copy-paste their way to
// a working connection without reading the rest of the page.
//
// When adding a new integration: add a row to `sections` AND a matching
// <Section id="..."> block below. Keep the heading order consistent across
// both lists so the on-this-page sidebar tracks correctly.

import DocsLayout, { Section, Sub, P, Steps, Bullets, Code, Callout, KV } from './DocsLayout';

const sections = [
  { id: 'overview',       label: '1. Overview' },
  { id: 'm365',           label: '2. Microsoft 365 (Azure AD)' },
  { id: 'google',         label: '3. Google Workspace' },
  { id: 'slack',          label: '4. Slack' },
  { id: 'teams',          label: '5. Microsoft Teams' },
  { id: 'gchat',          label: '6. Google Chat' },
  { id: 'whatsapp',       label: '7. WhatsApp' },
  { id: 'razorpay',       label: '8. Razorpay (billing)' },
  { id: 'troubleshooting', label: '9. Troubleshooting' },
];

export default function IntegrationsGuide() {
  return (
    <DocsLayout
      title="Integrations Setup Guide"
      subtitle="Connect Microsoft 365, Google Workspace, Slack, Teams, WhatsApp and other platforms to Wellness Extract — one platform per section."
      sections={sections}
      accent="cyan"
    >
      {/* 1. OVERVIEW */}
      <Section id="overview" title="1. Overview">
        <P>
          Wellness Extract connects to two families of external platforms — <strong>identity providers</strong>
          (Microsoft 365, Google Workspace) and <strong>messaging channels</strong> (Slack, Teams,
          Google Chat, WhatsApp). Identity providers sync your user + group directory; messaging
          channels deliver OTPs, credential-request approvals, and DLP alerts.
        </P>
        <Callout kind="info" title="One-time setup per platform">
          Each integration is set up <strong>once</strong> per platform by an org owner / admin in your
          Wellness Extract dashboard. After that, real-time sync handles the rest — you won't need to touch
          these screens again unless tokens are rotated or you change provider.
        </Callout>
        <Sub title="Where to manage integrations in Wellness Extract">
          <Bullets items={[
            <><strong>Directory</strong> (M365 + Google) → <code className="text-cyan-300">Employees → Integrations</code></>,
            <><strong>OTP channels</strong> (Slack / Teams / Google Chat / WhatsApp) → <code className="text-cyan-300">Employees → OTP Channels</code></>,
            <><strong>Billing</strong> (Razorpay) → <code className="text-cyan-300">Admin Portal → Billing</code></>,
          ]} />
        </Sub>
      </Section>

      {/* 2. MICROSOFT 365 */}
      <Section id="m365" title="2. Microsoft 365 (Azure AD)">
        <P>
          Syncs every user + group in your tenant into Wellness Extract so you can manage employees,
          assign managers, send credentials, and run offboardings from one place. Changes made in
          either system propagate to the other within 1–5 seconds via Microsoft Graph Change
          Notifications.
        </P>
        <Sub title="2.1 What you need">
          <Bullets items={[
            'Microsoft 365 / Entra global admin account (one-time consent only)',
            'No Azure App Registration setup — Wellness Extract uses its own multi-tenant app',
          ]} />
        </Sub>
        <Sub title="2.2 Setup steps">
          <Steps items={[
            <>In Wellness Extract, go to <code className="text-cyan-300">Employees → Integrations</code> → <strong>Connect Microsoft 365</strong>.</>,
            <>Microsoft login opens — sign in with a tenant <strong>global admin</strong> account.</>,
            <>Approve the permission consent screen (User.ReadWrite.All, Group.ReadWrite.All, Directory.ReadWrite.All, GroupMember.ReadWrite.All).</>,
            <>You're redirected back. Status flips to <strong>active</strong>, last_sync runs automatically, and real-time webhooks are subscribed within a few seconds.</>,
          ]} />
        </Sub>
        <Sub title="2.3 What you can do after connecting">
          <Bullets items={[
            'Edit a user\'s contact info (job title, office, phones, address, manager) in Wellness Extract — changes mirror to the M365 admin centre',
            'Assign managers in Wellness Extract — manager relationship is set in M365 too',
            'Add new employees from Wellness Extract → M365 user + license is created via Graph',
            'Send credentials, run offboardings, manage groups',
          ]} />
        </Sub>
        <Callout kind="warn" title="Permissions warning">
          The connection asks for <em>write</em> permissions because Wellness Extract creates / edits users.
          If you only want read access, sign in with a non-admin account first — but several features
          (Add employee, Manager push, Group membership) won't work.
        </Callout>
      </Section>

      {/* 3. GOOGLE WORKSPACE */}
      <Section id="google" title="3. Google Workspace">
        <P>
          Same shape as M365 — sync your Workspace users + groups into Wellness Extract, with full bi-directional
          sync on common fields.
        </P>
        <Sub title="3.1 Setup steps">
          <Steps items={[
            <>Go to <code className="text-cyan-300">Employees → Integrations</code> → <strong>Connect Google Workspace</strong>.</>,
            <>Sign in with a Workspace <strong>super admin</strong> account.</>,
            <>On the consent page, grant: <em>directory read/write</em>, <em>user read/write</em>, <em>group read/write</em>.</>,
            <>Redirect back → status flips to <strong>active</strong>.</>,
          ]} />
        </Sub>
        <Callout kind="info">
          Google Workspace push notifications run on a separate cadence (every ~6h) — full directory
          parity is achieved via periodic sync, not webhook push (yet).
        </Callout>
      </Section>

      {/* 4. SLACK */}
      <Section id="slack" title="4. Slack">
        <P>
          Sends OTPs, credential-request approvals, and DLP alerts to a Slack channel. Bot-token
          based — you create a Slack app in your workspace and paste the token + signing secret
          into Wellness Extract.
        </P>

        <Sub title="4.1 Create the Slack app">
          <Steps items={[
            <>Open <code className="text-cyan-300">https://api.slack.com/apps</code> → <strong>Create New App</strong> → <strong>From scratch</strong>.</>,
            <>Name it <em>Wellness Extract</em> (or anything), pick your workspace, click <strong>Create App</strong>.</>,
            <>You land on the <strong>Basic Information</strong> page. Leave it for now — we'll come back for the Signing Secret.</>,
          ]} />
        </Sub>

        <Sub title="4.2 Add bot scopes + install">
          <Steps items={[
            <>Left sidebar → <strong>OAuth &amp; Permissions</strong>.</>,
            <><strong>SKIP</strong> the "Token rotation" and "PKCE" sections at the top — Wellness Extract uses the simpler static-token pattern.</>,
            <>Scroll down to <strong>Scopes → Bot Token Scopes</strong>. Click <strong>Add an OAuth Scope</strong> and add these one by one:
              <Code>chat:write
chat:write.public
users:read
users:read.email</Code>
            </>,
            <>Scroll back up to <strong>OAuth Tokens</strong> → click <strong>Install to &lt;Workspace&gt;</strong>.</>,
            <>Slack asks which channel the bot should post to — pick the channel where you want OTPs / alerts to land (e.g. <code className="text-cyan-300">#it-alerts</code>). Click <strong>Allow</strong>.</>,
            <>After install you'll see <strong>Bot User OAuth Token</strong> starting with <code className="text-cyan-300">xoxb-…</code> — <strong>copy it</strong>.</>,
          ]} />
        </Sub>

        <Sub title="4.3 Grab the Signing Secret + Channel ID">
          <Steps items={[
            <>Left sidebar → <strong>Basic Information</strong> → <strong>App Credentials</strong> section → <strong>Signing Secret</strong> → click <strong>Show</strong> → <strong>copy</strong>.</>,
            <>In your Slack app/web, open the channel you picked. Click the channel name at the top → scroll to the bottom of the popup → <strong>Channel ID</strong> in format <code className="text-cyan-300">C0XXXXXXXXX</code> → copy.</>,
          ]} />
        </Sub>

        <Sub title="4.4 (Optional) Inbound replies — Event Subscriptions">
          <P>
            If you want users to reply to OTP messages <em>inside Slack</em> (instead of clicking a link
            back to Wellness Extract), enable Event Subscriptions:
          </P>
          <Steps items={[
            <>Left sidebar → <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong>.</>,
            <>In <strong>Request URL</strong>, paste:
              <Code>https://api-ems.wellnessextract.com/functions/v1/otp-inbound-slack?org=&lt;your-org-id&gt;</Code>
              Replace <code>&lt;your-org-id&gt;</code> with the value shown on your Wellness Extract OTP Settings page (a UUID).
            </>,
            <>Slack verifies the URL → green tick. Then under <strong>Subscribe to bot events</strong> add <code className="text-cyan-300">message.channels</code>.</>,
            <><strong>Save Changes</strong> at the bottom.</>,
          ]} />
          <Callout kind="warn">
            If you skip this step, OTPs still get delivered to Slack — users just click the
            "Approve in Wellness Extract" button instead of replying inside Slack.
          </Callout>
        </Sub>

        <Sub title="4.5 Plug into Wellness Extract">
          <Steps items={[
            <>Open <code className="text-cyan-300">ems.wellnessextract.com/employees/otp-settings</code> → <strong>Slack</strong> card.</>,
            <>Paste <strong>Bot token</strong> (the xoxb-…), <strong>Channel ID</strong> (C0XXX…), <strong>Signing Secret</strong>.</>,
            <><strong>Save</strong>. Status flips to <strong>connected</strong>. Try the <strong>Send test</strong> button — a test message should appear in your channel within a few seconds.</>,
          ]} />
        </Sub>

        <Sub title="4.6 What NOT to do">
          <Bullets items={[
            <><strong>Client ID / Client Secret</strong> on the Basic Information page → ignore. They're only needed for full OAuth (we don't use that flow).</>,
            <><strong>Verification Token</strong> (deprecated) → ignore. Slack replaced it with the Signing Secret.</>,
            <>Don't click <strong>Regenerate</strong> on the Client Secret without telling everyone — already-installed instances will need to reinstall.</>,
          ]} />
        </Sub>
      </Section>

      {/* 5. MICROSOFT TEAMS */}
      <Section id="teams" title="5. Microsoft Teams">
        <P>
          Two ways to send to Teams — pick one:
        </P>
        <Sub title="5.1 Easiest: Incoming Webhook (per-channel)">
          <Steps items={[
            <>Open the target Teams channel → <strong>… (more options)</strong> → <strong>Connectors</strong>.</>,
            <>Find <strong>Incoming Webhook</strong> → <strong>Configure</strong>.</>,
            <>Name it <em>Wellness Extract</em>, optionally upload an icon, click <strong>Create</strong>.</>,
            <>Teams gives you a <strong>webhook URL</strong> (starts with <code className="text-cyan-300">https://….webhook.office.com/…</code>). Copy it.</>,
            <>In Wellness Extract OTP Settings → Teams card → paste the webhook URL → Save.</>,
          ]} />
          <Callout kind="info">
            Webhook-only means one-way delivery (Wellness Extract → Teams). Users can't reply inside Teams.
            Good for alerts; less ideal for OTP approvals.
          </Callout>
        </Sub>
        <Sub title="5.2 Full Graph integration (interactive)">
          <P>
            Requires the same M365 Azure AD consent as the directory integration plus
            <code className="text-cyan-300"> ChannelMessage.Send</code> and
            <code className="text-cyan-300"> Chat.ReadWrite</code> scopes. If your org has already
            connected Microsoft 365 in Wellness Extract, Teams interactive mode is automatically available —
            in the Teams card, pick a Team + Channel from the dropdowns (populated from Graph) and
            Save.
          </P>
        </Sub>
      </Section>

      {/* 6. GOOGLE CHAT */}
      <Section id="gchat" title="6. Google Chat">
        <P>
          Google Chat is bidirectional: Wellness Extract <strong>posts</strong> OTP cards into your space via a
          webhook, and admins <strong>reply</strong> inside the same space — the reply goes to the
          <em> Wellness Extract Chat App</em> which fulfills the pending OTP request in real-time. No magic-link
          round-trip.
        </P>
        <Callout kind="info" title="Two pieces to wire up">
          (a) <strong>Outbound webhook</strong> — created by you inside the space (5 min). Sends
          OTP cards from Wellness Extract → Chat. <br />
          (b) <strong>Inbound: add the Wellness Extract Chat App</strong> — once-per-space click to install. Lets
          admins reply with the OTP code inside Chat → Wellness Extract.
        </Callout>

        <Sub title="6.1 Outbound — Incoming webhook (5 min, one-time per space)">
          <Steps items={[
            <>Open the Google Chat space where you want OTP notifications.</>,
            <>Click the space name at the top → <strong>Apps &amp; integrations</strong> → <strong>Webhooks</strong> tab.</>,
            <><strong>Add webhook</strong> → name it <em>Wellness Extract OTP</em> → <strong>Save</strong>.</>,
            <>Copy the generated URL — looks like <code className="text-cyan-300">https://chat.googleapis.com/v1/spaces/AAAA…/messages?key=…&amp;token=…</code></>,
            <>In Wellness Extract: <code className="text-cyan-300">Employees → OTP Channels → Google Chat → Outbound webhook URL</code> → paste → leave Space ID for now.</>,
          ]} />
        </Sub>

        <Sub title="6.2 Find your Space ID">
          <Steps items={[
            <>In the same space, click the space name at the top.</>,
            <>Scroll down in the popup → find <strong>Space ID</strong> (looks like <code className="text-cyan-300">spaces/AAAAxxxxx</code>). Copy it.</>,
            <>Paste it into Wellness Extract → Google Chat card → <strong>Space ID</strong> → <strong>Save</strong>.</>,
          ]} />
          <Callout kind="warn">
            Space ID is what links incoming replies from this space back to your org. Without it,
            outbound still works but admin replies inside Chat won't fulfill the OTP — they'd need to
            click the magic link in the card instead.
          </Callout>
        </Sub>

        <Sub title="6.3 Inbound — Add the Wellness Extract Chat App to your space">
          <P>
            We publish a Chat App called <strong>Wellness Extract OTP</strong> in Google Workspace Marketplace.
            One-click install:
          </P>
          <Steps items={[
            <>In the space, click <strong>Apps &amp; integrations</strong> → <strong>+ Add apps</strong>.</>,
            <>Search for <strong>Wellness Extract OTP</strong> → click <strong>Add</strong>.</>,
            <>Approve the prompt. The bot will post a "Hi, I'm online" message into the space.</>,
            <>That's it. The bot listens for messages in this space (and only this space — Google scopes Chat App events to where it's added) and routes them back to your Wellness Extract org via the Space ID you saved above.</>,
          ]} />
          <Callout kind="info" title="What admins do during an OTP">
            When Wellness Extract posts an OTP card (e.g. "Acme platform needs a code"), the assigned admin
            just replies in the space with the 6-digit code. Within 1–2 seconds the bot answers
            "✅ OTP received and applied" and Wellness Extract completes the workflow.
          </Callout>
        </Sub>

        <Sub title="6.4 Verify end-to-end">
          <Steps items={[
            <>In Wellness Extract Vault → trigger a credential fetch that needs an OTP.</>,
            <>Card appears in your Google Chat space.</>,
            <>Reply with the OTP code (just type the digits — spaces / dashes are OK).</>,
            <>Bot replies <strong>✅ OTP received and applied</strong>. Vault shows the credential is updated.</>,
          ]} />
        </Sub>

        <Sub title="6.5 Common errors">
          <KV k="Bot says 'no org has linked this space yet'" v="You added the bot but didn't paste the Space ID into Wellness Extract. Copy the ID the bot mentioned and paste it under Google Chat → Space ID, then Save." />
          <KV k="Bot doesn't reply at all" v="Make sure you added the Wellness Extract OTP app to the space (step 6.3), not just the webhook. Webhook = outbound only." />
          <KV k="Outbound card never arrives" v="Webhook URL expired or webhook deleted in the space. Recreate via Manage webhooks and paste the new URL into Wellness Extract." />
        </Sub>
      </Section>

      {/* 7. WHATSAPP */}
      <Section id="whatsapp" title="7. WhatsApp">
        <P>
          WhatsApp delivers OTPs via either <strong>Meta Cloud API</strong> (direct) or
          <strong> Twilio</strong> (managed). Meta Cloud is cheaper at scale; Twilio is faster to set up.
        </P>
        <Sub title="7.1 Meta Cloud API">
          <Steps items={[
            <>Create a Meta Business / WhatsApp Business app at <code className="text-cyan-300">developers.facebook.com</code>.</>,
            <>Add a <strong>WhatsApp</strong> product → register a phone number → get the <strong>Phone Number ID</strong>.</>,
            <>Create a permanent access token (System User → assign to the WhatsApp asset → generate token with <code>whatsapp_business_messaging</code> scope).</>,
            <>Submit an OTP template for approval (e.g. <em>otp_wellness_extract_v1</em>). One business day for Meta to approve.</>,
            <>In Wellness Extract OTP Settings → WhatsApp card: provider = <strong>Meta Cloud</strong>, paste the Phone Number ID + access token + approved template name → Save.</>,
          ]} />
        </Sub>
        <Sub title="7.2 Twilio">
          <Steps items={[
            <>Twilio Console → Messaging → <strong>WhatsApp Senders</strong> → request a sender (15-min for sandbox, 1–3 days for production).</>,
            <>Copy the <strong>Account SID</strong>, <strong>Auth Token</strong>, and approved <strong>template SID</strong>.</>,
            <>In Wellness Extract: provider = <strong>Twilio</strong>, paste the three values → Save.</>,
          ]} />
        </Sub>
        <Callout kind="warn">
          WhatsApp requires <strong>approved templates</strong> for non-conversational messages —
          you can't send free-form OTP text until Meta or Twilio approves your template. Plan a
          1–3 day buffer.
        </Callout>
      </Section>

      {/* 8. RAZORPAY */}
      <Section id="razorpay" title="8. Razorpay (billing)">
        <P>
          Used by the signup flow for the ₹2 card-verification charge and for yearly subscription
          renewals. Most customers don't need to configure this — Wellness Extract uses its own Razorpay
          account by default.
        </P>
        <Sub title="When you might need your own Razorpay">
          <Bullets items={[
            'You\'re a Wellness Extract channel partner reselling licenses and want collections to land in your own bank account',
            'Your finance team prefers separate merchant settlements per region',
          ]} />
          <P>
            Open <code className="text-cyan-300">Admin Portal → Billing → Razorpay</code> → paste your
            Razorpay Key ID + Key Secret → assign a subset of orgs to bill via your merchant.
          </P>
        </Sub>
      </Section>

      {/* 9. TROUBLESHOOTING */}
      <Section id="troubleshooting" title="9. Troubleshooting">
        <Sub title="The integration status stays 'connecting' / 'syncing' forever">
          <Bullets items={[
            'Reload the page after 2 minutes. The sync finishes in the background; the page just hasn\'t refreshed.',
            'If still stuck: Disconnect from the Integrations page, then Connect again. The fresh OAuth grants new tokens.',
          ]} />
        </Sub>
        <Sub title="OTP test message doesn't arrive">
          <KV k="Slack" v="Channel ID mismatch (must be C0XXX… not the channel name), or bot not invited to a private channel (run /invite @Wellness Extract in the channel)." />
          <KV k="Teams" v="Webhook URL expired (Teams rotates them every 90 days for some tenants). Regenerate in Teams → Connectors → Configure." />
          <KV k="WhatsApp" v="Template not yet approved by Meta / Twilio. Check the provider dashboard." />
        </Sub>
        <Sub title="Microsoft 365 sync shows 404 for a group">
          <P>
            That group was deleted in Azure AD between us listing it and trying to expand its members.
            Wellness Extract now skips missing groups silently — no action needed. Run "Sync now" if you want
            the group removed from Wellness Extract immediately.
          </P>
        </Sub>
        <Sub title="Still stuck?">
          <P>
            Email <code className="text-cyan-300">support@wellnessextract.com</code> with the platform name +
            a screenshot of the integration card. We respond within one business day.
          </P>
        </Sub>
      </Section>
    </DocsLayout>
  );
}
