#!/usr/bin/env bash
# install-service-macos.sh
# Installs TrackForce Agent as a system-wide LaunchDaemon so it survives logout
# and is auto-restarted on kill.
#
# Run with sudo. Idempotent.
#
#   sudo bash install-service-macos.sh
#   sudo bash install-service-macos.sh --uninstall

set -euo pipefail

LABEL="com.trackforce.agent"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
APP="/Applications/TrackForce Agent.app/Contents/MacOS/TrackForce Agent"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Unloading $LABEL …"
  /bin/launchctl bootout system "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Done."
  exit 0
fi

if [[ ! -x "$APP" ]]; then
  echo "❌ Agent binary not found at $APP. Install the .pkg/.dmg first." >&2
  exit 1
fi

# KeepAlive=true respawns whenever the process exits for any reason.
# ThrottleInterval=5 caps respawn rate so a CPU-bound crash loop doesn't burn cycles.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/var/log/trackforce-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/trackforce-agent.err.log</string>
</dict>
</plist>
EOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"

echo "Loading $LABEL …"
/bin/launchctl bootstrap system "$PLIST"

echo ""
echo "✅ TrackForce Agent LaunchDaemon installed."
echo "   Auto-restart is active (5-second throttle)."
echo "   In-process guardian provides additional resilience."
echo ""
echo "   To uninstall: sudo bash install-service-macos.sh --uninstall"
