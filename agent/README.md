# TrackForce Agent

Cross-platform desktop monitoring agent built with Tauri 2 + Rust.

## What this Step (2.1) ships

- Tauri 2 project scaffold (Rust + React frontend)
- One-time setup screen: paste Supabase URL + anon key
- Enrollment screen: paste org license key + your name → registers an `agents` row via the `enroll-agent` Edge Function and stores the returned `enroll_token` locally
- Background loop: every 60s collects CPU/RAM/disk usage with `sysinfo` and pushes a row to `system_metrics` via the `ingest` Edge Function
- Status panel: shows enrollment, last sync, last error

Active-window tracking, screenshots, and idle detection come in Steps 2.2–2.4.

## One-time prerequisites

```bash
# 1. Rust (skip if already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Restart your terminal afterwards.

# 2. macOS build tools
xcode-select --install   # noop if installed

# 3. Supabase CLI (only needed to deploy Edge Functions)
brew install supabase/tap/supabase

# 4. App icons — Tauri requires icons, copy a 1024x1024 PNG to icons/icon.png then:
#    cargo install tauri-cli --version "^2"
#    cd agent && cargo tauri icon icons/icon.png
#    (Or download a placeholder set; Tauri will fail to build without icons/.)
```

## Deploy Edge Functions

From the **repo root** (one directory above `agent/`):

```bash
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>   # find ref in Project Settings → General

# Deploy the two functions
supabase functions deploy enroll-agent
supabase functions deploy ingest
```

The `SUPABASE_SERVICE_ROLE_KEY` env var is auto-injected by Supabase at runtime — you don't have to set it.

Also run the new migration in the SQL editor:

```sql
-- Paste contents of supabase/migrations/0002_agent_enrollment.sql
```

## Run the agent in dev

```bash
cd agent
npm install
npm run tauri:dev
```

First launch:
1. Paste Supabase URL + anon key (same values you put in the dashboard `.env`).
2. Paste org license key (visible on `/setup` page in the dashboard).
3. Enter employee name → click Enroll.
4. Wait ~60s and check the dashboard `/agents` — you should see a new agent row with `system_metrics` flowing in.

## Video recording prerequisites

Video clips are recorded via the system `ffmpeg` binary on PATH. The agent detects ffmpeg at runtime — if absent, video ticks log a warning and are skipped silently (other captures continue working).

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Ubuntu/Debian
winget install ffmpeg        # Windows
```

For a self-contained installer, bundle `ffmpeg` into the app via Tauri's `bundle.resources` field in `tauri.conf.json` and set `PATH` from the bundle dir at startup. Defer that to ROLLOUT.md once you decide on signing/distribution.

Defaults: 10-second clip, 720p, H.264, no audio, every 30 minutes per agent. All admin-toggleable from the agent-detail page (Capture Controls).

## Background-mode behaviour

- Closing the window does **not** quit the app — it hides into the system tray.
- Tray icon menu: **Show TrackForce / Pause monitoring / Resume monitoring / Quit**.
- Left-click the tray icon to bring the window back.
- The "Settings" card inside the app exposes:
  - **Pause monitoring** — gates all background ticks (no metrics / window / screenshot / idle pushes while paused).
  - **Start at login** — registers the agent with the OS login items via `tauri-plugin-autostart`. On first install IT can pre-enable this with the `--enable-autostart` deploy flag in your bundler (or call the `set_autostart` Tauri command from a post-install script).

## Build a release artifact

```bash
cd agent
npm run tauri:build
```

Output:
- macOS: `agent/src-tauri/target/release/bundle/dmg/*.dmg`
- Windows: `agent/src-tauri/target/release/bundle/msi/*.msi`
- Linux: `agent/src-tauri/target/release/bundle/{deb,appimage}/*`

## Configuration override via env vars

For automated mass-deployment you can pre-populate Supabase config without showing the UI screen by setting:

```
TRACKFORCE_SUPABASE_URL=https://xxx.supabase.co
TRACKFORCE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

These take precedence over `agent.json` on disk. Stored in `~/Library/Application Support/TrackForceAgent/agent.json` (macOS), `%APPDATA%\TrackForceAgent\agent.json` (Windows), `~/.local/share/TrackForceAgent/agent.json` (Linux).

## Code signing & distribution (production)

Tauri builds unsigned binaries by default. Each platform needs its own signing setup before users can install without scary warnings:

### macOS — `.dmg`

1. Apple Developer Program membership ($99/yr) required.
2. Create a "Developer ID Application" certificate in Apple Developer → Certificates.
3. Set env vars before `npm run tauri:build`:
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_ID="you@apple.com"
   export APPLE_PASSWORD="app-specific-password"   # appleid.apple.com → App-Specific Passwords
   export APPLE_TEAM_ID="TEAMID"
   ```
4. Tauri's bundler will sign + notarize automatically. Verify with `spctl -a -vv <Agent.app>`.
5. **Permissions:** the agent needs *Screen Recording* and *Accessibility* — macOS will prompt on first launch. For MDM-managed fleets, deploy a TCC profile via Jamf/Kandji that pre-grants these.

### Windows — `.msi`

1. EV code-signing certificate from a CA (DigiCert, Sectigo) — required to avoid SmartScreen warnings.
2. Set env vars:
   ```cmd
   set TAURI_SIGNING_PRIVATE_KEY=path\to\cert.pfx
   set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
   ```
3. For mass deployment via GPO/Intune the `.msi` accepts standard MSIEXEC flags. Pre-bake Supabase URL/key with an MST transform or a config preset script in the installer.

### Linux — `.deb` / `.rpm`

1. No mandatory signing, but `apt`/`dnf` repos benefit from GPG-signed packages.
2. The `.deb` postinst script can call `systemctl --user enable trackforce-agent` to autostart for desktop users; for headless deployment use a `LaunchAgent` or systemd user unit.

### Auto-update (silent OTA)

The agent already ships with `tauri-plugin-updater` wired up — it runs `updater.check()` 20 seconds after launch and every 6 hours afterward. To activate it you need to (one-time):

1. **Generate a signing keypair** (separate from your code-signing cert):
   ```bash
   cd agent
   npm run tauri signer generate -- -w ~/.tauri/trackforce-update.key
   ```
   It prints a public key. Keep the **private key file safe** — it's how clients verify updates.

2. **Set the public key** in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (replace the empty string).

3. **Set the endpoint URL** (also in `tauri.conf.json` → `plugins.updater.endpoints[0]`). Default points at a public Supabase Storage object — works for any HTTPS URL hosting a JSON file with this shape:
   ```json
   {
     "version": "0.2.0",
     "notes": "Bug fixes & new active-window detector",
     "pub_date": "2026-05-15T12:00:00Z",
     "platforms": {
       "darwin-aarch64": { "signature": "<sig>", "url": "https://.../trackforce_0.2.0_aarch64.app.tar.gz" },
       "darwin-x86_64":  { "signature": "<sig>", "url": "https://.../trackforce_0.2.0_x64.app.tar.gz" },
       "windows-x86_64": { "signature": "<sig>", "url": "https://.../trackforce_0.2.0_x64-setup.nsis.zip" },
       "linux-x86_64":   { "signature": "<sig>", "url": "https://.../trackforce_0.2.0_amd64.AppImage.tar.gz" }
     }
   }
   ```

4. **Publish a release** every time you want fleet-wide updates:
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/trackforce-update.key)
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
   npm run tauri:build              # produces signed bundles + .sig files
   ```
   Upload the platform bundles + `latest.json` (the manifest above) to Supabase Storage's `releases/` bucket (public, or private with a signed URL endpoint).

5. Existing agents notice the new manifest within 6 hours, download in the background, install, and restart.

The plugin's `dialog: false` setting keeps the update silent — no user prompt. Drop it for an opt-in confirmation dialog.
