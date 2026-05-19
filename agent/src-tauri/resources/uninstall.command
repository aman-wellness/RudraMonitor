#!/usr/bin/env bash
# Double-click this file (or run from Terminal) to fully uninstall the Rudrans Agent
# from a macOS machine. Removes:
#   - LaunchAgent autostart entry (~/Library/LaunchAgents/com.rudrans.agent.plist)
#   - On-disk config + enrollment data (~/Library/Application Support/RudransAgent/)
#   - The Rudrans Agent.app bundle from /Applications (or ~/Applications)
#
# Safe to run multiple times — anything already missing is silently ignored.
# Also removes legacy TrackForce-branded leftovers for users upgrading from old builds.

set -u

APP_NAME="Rudrans Agent"
BUNDLE_ID="com.rudrans.agent"
DATA_DIR="RudransAgent"

# 1. Disable autostart.
LAUNCH_AGENT="$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
if [ -f "$LAUNCH_AGENT" ]; then
  launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
  rm -f "$LAUNCH_AGENT"
fi

# 2. Stop any running agent + guardian instance. Best-effort — pkill returns 1 when
# no match is found, which is fine.
pkill -f "$APP_NAME" 2>/dev/null || true
pkill -f "rudrans-agent" 2>/dev/null || true
pkill -f "rudrans_agent" 2>/dev/null || true

# 3. Wipe config + enrollment + logs.
rm -rf "$HOME/Library/Application Support/${DATA_DIR}" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/${BUNDLE_ID}" 2>/dev/null || true
rm -rf "$HOME/Library/Logs/${APP_NAME}" 2>/dev/null || true

# 4. Delete the app bundle. Try /Applications first, then ~/Applications.
for APP_DIR in "/Applications" "$HOME/Applications"; do
  TARGET="${APP_DIR}/${APP_NAME}.app"
  if [ -d "$TARGET" ]; then
    if rm -rf "$TARGET" 2>/dev/null && [ ! -d "$TARGET" ]; then
      echo "Removed ${TARGET}"
    else
      # /Applications usually requires sudo; ask the user once.
      echo "${TARGET} requires admin rights to remove."
      sudo rm -rf "$TARGET"
    fi
  fi
done

# 5. Legacy TrackForce cleanup — silently remove old-brand leftovers so users
# upgrading from pre-rename builds don't carry stale state.
launchctl unload "$HOME/Library/LaunchAgents/com.trackforce.agent.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.trackforce.agent.plist" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/TrackForceAgent" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/com.trackforce.agent" 2>/dev/null || true
for LEGACY in "/Applications/TrackForce Agent.app" "$HOME/Applications/TrackForce Agent.app"; do
  if [ -d "$LEGACY" ]; then
    rm -rf "$LEGACY" 2>/dev/null || sudo rm -rf "$LEGACY"
  fi
done

echo
echo "Rudrans Agent uninstalled."
