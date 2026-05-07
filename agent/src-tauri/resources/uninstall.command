#!/usr/bin/env bash
# Double-click this file (or run from Terminal) to fully uninstall the TrackForce Agent
# from a macOS machine. Removes:
#   - LaunchAgent autostart entry (~/Library/LaunchAgents/com.trackforce.agent.plist)
#   - On-disk config + enrollment data (~/Library/Application Support/TrackForceAgent/)
#   - The TrackForce Agent.app bundle from /Applications (or ~/Applications)
#
# Safe to run multiple times — anything already missing is silently ignored.

set -u

APP_NAME="TrackForce Agent"
BUNDLE_ID="com.trackforce.agent"

# 1. Disable autostart.
LAUNCH_AGENT="$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
if [ -f "$LAUNCH_AGENT" ]; then
  launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
  rm -f "$LAUNCH_AGENT"
fi

# 2. Stop any running agent instance.
pkill -f "$APP_NAME" 2>/dev/null || true
pkill -f "trackforce-agent" 2>/dev/null || true

# 3. Wipe config + enrollment.
rm -rf "$HOME/Library/Application Support/TrackForceAgent" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/${BUNDLE_ID}" 2>/dev/null || true
rm -rf "$HOME/Library/Logs/${APP_NAME}" 2>/dev/null || true

# 4. Delete the app bundle. Try /Applications first, then ~/Applications.
for APP_DIR in "/Applications" "$HOME/Applications"; do
  TARGET="${APP_DIR}/${APP_NAME}.app"
  if [ -d "$TARGET" ]; then
    rm -rf "$TARGET" 2>/dev/null
    if [ ! -d "$TARGET" ]; then
      echo "Removed ${TARGET}"
    else
      # /Applications usually requires sudo; ask the user once.
      echo "${TARGET} requires admin rights to remove."
      sudo rm -rf "$TARGET"
    fi
  fi
done

echo
echo "TrackForce Agent uninstalled."
