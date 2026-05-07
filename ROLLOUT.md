# TrackForce Rollout Checklist

End-to-end steps for taking TrackForce from "works on my machine" to "deployed on real employee laptops". Each section is ordered. Skip nothing in **Required**; **Optional** is for production polish.

---

## 1. Database (Required, ~10 min)

In the Supabase SQL editor, paste each migration file in order and click **Run**:

| # | File | What it does |
|---|------|--------------|
| 1 | `supabase/schema.sql` | Base tables + RLS |
| 2 | `supabase/migrations/0001_agent_fields.sql` | `agents.department`, `machine_name` |
| 3 | `supabase/migrations/0002_agent_enrollment.sql` | unique indexes on license/machine/token |
| 4 | `supabase/migrations/0003_screenshots.sql` | screenshots bucket + storage RLS |
| 5 | `supabase/migrations/0004_alerts_resolution.sql` | UPDATE policy on alerts |
| 6 | `supabase/migrations/0005_productivity_rules.sql` | `productivity_rules` table + RLS |
| 7 | `supabase/migrations/0006_org_invites.sql` | pending invites + auth trigger |
| 8 | `supabase/migrations/0007_aggregation.sql` | RPCs + indexes for dashboard speed |
| 9 | `supabase/migrations/0008_per_agent_aggregation.sql` | per-agent RPC for reports |
| 10 | `supabase/migrations/0009_data_retention.sql` | `trackforce_purge_old_data()` + (optional) cron |

For #10's cron schedule to work, enable **pg_cron** at Supabase → Database → Extensions before running the migration.

## 2. Edge Functions (Required, ~5 min)

```bash
# One-time
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>

# Deploy each function
supabase functions deploy enroll-agent
supabase functions deploy ingest
supabase functions deploy upload-screenshot
supabase functions deploy invite-member
```

`SUPABASE_SERVICE_ROLE_KEY` is auto-injected by Supabase at runtime.

## 3. Auth provider config (Required if using OAuth)

Supabase Dashboard → **Authentication → Providers**:

- **Email**: enabled by default. Set **Site URL** under **URL Configuration** to your dashboard URL — invite links use this.
- **Google**: create OAuth client at console.cloud.google.com → set redirect URI to `https://<project>.supabase.co/auth/v1/callback`.
- **Microsoft (Azure AD)**: register an app at portal.azure.com → same redirect URI.

## 4. Dashboard env (Required, ~1 min)

`/track-force/.env`:
```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

## 5. Dashboard hosting (Required, ~10 min)

The dashboard is a plain Vite SPA. Any of these works:

- **Vercel**: connect repo → set the two env vars → deploy. **Default.**
- **Netlify**: same idea, drop in the vars.
- **Self-host**: `npm run build` → serve `dist/` from any static host (S3 + CloudFront, nginx, Cloudflare Pages).

After deploy, set Supabase **Site URL** to the hosting URL.

---

## 6. Agent app (Required for real monitoring)

### 6.1 Icons

Tauri's bundler refuses to build without icon files. Two options:

```bash
# Option A: branded icon
cp /path/to/your/1024x1024.png agent/src-tauri/icons/icon.png
cd agent && npx tauri icon src-tauri/icons/icon.png

# Option B: placeholder (dev only)
cd agent && bash scripts/generate-placeholder-icon.sh
npx tauri icon src-tauri/icons/icon.png
```

### 6.1.1 ffmpeg (only if you want video recording)

Video capture relies on a system `ffmpeg` binary on PATH. Skip this section if you only need screenshots.

For dev/internal: install via package manager.
```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Ubuntu/Debian
winget install ffmpeg        # Windows
```

For production fleets, bundle ffmpeg with the agent so end-user laptops don't need a separate install. In `agent/src-tauri/tauri.conf.json`:

```json
"bundle": {
  "resources": ["bin/ffmpeg"]
}
```

Drop platform-specific binaries under `agent/src-tauri/bin/ffmpeg-{darwin-aarch64,darwin-x86_64,windows-x86_64,linux-x86_64}` and adjust `video.rs` to spawn the bundled path instead of plain `ffmpeg` (use `tauri::path::resolve_path`). Bundles add ~80 MB but eliminate per-machine setup.

Note: ffmpeg is LGPL by default — fine for redistribution. Avoid GPL builds (with libx264 statically linked + `--enable-gpl`) unless your distribution license is GPL-compatible.

### 6.2 First build (unsigned)

```bash
cd agent
npm install
npm run tauri:build
```

Output:
- macOS: `agent/src-tauri/target/release/bundle/dmg/*.dmg`
- Windows: `agent/src-tauri/target/release/bundle/msi/*.msi`
- Linux: `agent/src-tauri/target/release/bundle/{deb,appimage}/*`

These work for internal testing but show OS warnings. For real distribution, sign them.

### 6.3 macOS code signing (Required for non-developer machines)

Apple Developer Program ($99/yr) → Certificates → "Developer ID Application".

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@apple.com"
export APPLE_PASSWORD="app-specific-password"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="TEAMID"
npm run tauri:build
```

The bundler will sign + notarize automatically. Verify:
```bash
spctl -a -vv "src-tauri/target/release/bundle/macos/TrackForce Agent.app"
```

### 6.4 Windows code signing (Required for non-EV friction)

EV code-signing certificate from a CA (DigiCert, Sectigo, ~$300-700/yr).

```cmd
set TAURI_SIGNING_PRIVATE_KEY=path\to\cert.pfx
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
npm run tauri:build
```

### 6.5 macOS permissions (Required at install time)

The agent needs **Screen Recording** + **Accessibility** to read window titles and capture screens. Each user gets a system prompt on first launch. For corporate fleets:

- Jamf / Kandji / Mosyle: deploy a TCC profile that pre-grants the bundle ID `com.trackforce.agent` access to those services.

### 6.6 Distribution

Three patterns, pick one:

- **Direct download**: `/setup` page in the dashboard already shows the right OS download. Host the bundles on Supabase Storage public bucket and put the URLs in `src/pages/setup/components/OSCard.tsx`.
- **MDM / Group Policy**: Windows MSI deployable via Intune, GPO. macOS PKG via Jamf. Linux .deb via apt repo.
- **Email link**: send each employee a Supabase Storage signed URL that downloads the right binary.

### 6.7 Mass-deploy with prebaked Supabase config

To skip the manual "paste URL/key" step on every machine, set env vars at install time:

```
TRACKFORCE_SUPABASE_URL=https://xxx.supabase.co
TRACKFORCE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

These take precedence over `agent.json` on disk. For Windows MSI, embed via an MST transform; for macOS pkg, set via a postinstall script writing to `/etc/launchd.conf` or LaunchAgents plist; for Linux, set in the systemd user unit.

---

## 7. Auto-update (Optional, recommended)

See **agent/README.md** → "Auto-update (silent OTA)" for the full flow. Summary:

1. `npm run tauri signer generate -- -w ~/.tauri/trackforce-update.key`
2. Paste public key into `agent/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
3. Set the manifest URL at `plugins.updater.endpoints[0]` (Supabase Storage path)
4. On every release: `npm run tauri:build` (with the signing env var) → upload bundles + a `latest.json` manifest

Existing agents check on launch and every 6 hours; updates install silently.

---

## 8. Smoke test (~30 min)

In order:

1. Log in via dashboard, create org via signup.
2. `/setup` → copy license key.
3. Install agent on a test laptop. Paste Supabase URL + anon key. Paste license key + employee name. Enroll.
4. Wait 60s → `/system-health` shows real CPU/RAM/disk.
5. Switch apps & browse a few sites → `/monitoring → Applications` and `Browser` tabs populate within ~30s.
6. Don't touch keyboard for 5 min → `Idle` tab shows the period.
7. CPU stress (`yes >/dev/null` × 4) → `/alerts` page gets a row.
8. After 5 min total → `Screenshots` tab shows the first capture.
8b. (If ffmpeg installed) Toggle "Video Recording" ON in agent-detail → Capture Controls. After the configured interval (default 30 min) → `Videos` tab shows the first clip. Click to play in the lightbox.
9. Click a category badge in `Applications` → mark as Productive → `Avg Productivity` on dashboard updates.
10. Admin Portal → Users → invite a teammate → they get the email and can log in.

If all 10 work, you're shipping ready.

---

## 9. Operational (Optional)

- **Data retention**: `0009_data_retention.sql` deletes `activity_logs > 90 days` and `system_metrics > 30 days` daily. Tune as needed.
- **Monitoring the monitor**: Supabase Logs → Postgres → spikes in error log = misbehaving agents.
- **Backups**: Supabase paid plans include daily backups. Free tier doesn't — add `pg_dump` cron if you care.
- **Storage cost**: screenshots dominate. ~150KB × 12/hr × 8hr × 20 days = ~280 MB/agent/month. With 50 agents = 14 GB/month. Upgrade Supabase plan or shorten capture interval in `agent/src-tauri/src/lib.rs` (`SCREENSHOT_INTERVAL_SECS`).
