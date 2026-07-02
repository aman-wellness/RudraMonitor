#!/usr/bin/env bash
# Fully uninstall the Security Assistant / Wellness Extract endpoint agent
# from a macOS machine. Removes:
#   - LaunchAgent autostart plist (~/Library/LaunchAgents/com.wellnessextract.agent.plist)
#   - Running agent + guardian + ffmpeg helper processes
#   - Config + enrollment JSON (~/Library/Application Support/RudransAgent/)
#   - Cached ffmpeg binary + models (~/Library/Caches/com.wellnessextract.agent/)
#   - Application logs (~/Library/Logs/WellnessExtractAgent/)
#   - The Security Assistant.app bundle from /Applications (or ~/Applications)
#
# Safe to run multiple times. Also cleans up every legacy brand (Rudrans
# Agent, TrackForce Agent) so users upgrading from very old builds don't
# carry stale plists that respawn the deleted process on next login.

set -u

# Every combination of app name + bundle id we've ever shipped, in
# reverse-chronological order. First entry is the CURRENT identity.
APP_NAMES=(
  "Security Assistant"
  "Rudrans Agent"
  "TrackForce Agent"
)
BUNDLE_IDS=(
  "com.wellnessextract.agent"
  "com.rudrans.agent"
  "com.trackforce.agent"
)

echo "Uninstalling endpoint agent from $(scutil --get ComputerName 2>/dev/null || hostname)…"

# 1. Disable autostart — every legacy plist too, because a v0.2.x machine
# upgrading to v0.6.x still has com.trackforce.agent.plist on disk.
for BUNDLE_ID in "${BUNDLE_IDS[@]}"; do
  PLIST="$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "  removed LaunchAgent: ${BUNDLE_ID}"
  fi
done

# 2. Kill any running instance. Grep-match by app name AND by known process
# names so ffmpeg/rustdesk helpers spawned by the agent go with it.
for NAME in "${APP_NAMES[@]}"; do
  pkill -f "${NAME}.app" 2>/dev/null || true
done
pkill -f "wellness-extract-agent" 2>/dev/null || true
pkill -f "rudrans-agent"         2>/dev/null || true
pkill -f "rudrans_agent"         2>/dev/null || true
# Bundled ffmpeg pattern is the same across brands — path lives inside .app/Resources.
pkill -f "Security Assistant.app/Contents/Resources/ffmpeg" 2>/dev/null || true
pkill -f "Rudrans Agent.app/Contents/Resources/ffmpeg"     2>/dev/null || true
pkill -f "TrackForce Agent.app/Contents/Resources/ffmpeg"  2>/dev/null || true

# 3. Wipe config + caches + logs. Data dir has always been "RudransAgent"
# (not renamed across brand pivots for backwards compat) — sweep the
# other historical names for completeness anyway.
for DIR in RudransAgent WellnessExtractAgent SecurityAssistant TrackForceAgent; do
  rm -rf "$HOME/Library/Application Support/${DIR}" 2>/dev/null || true
done
for BUNDLE_ID in "${BUNDLE_IDS[@]}"; do
  rm -rf "$HOME/Library/Caches/${BUNDLE_ID}" 2>/dev/null || true
done
for LOGDIR in WellnessExtractAgent SecurityAssistant RudransAgent TrackForceAgent; do
  rm -rf "$HOME/Library/Logs/${LOGDIR}" 2>/dev/null || true
done

# 4. Delete every historical .app bundle. Try /Applications first, then
# ~/Applications for user-scope installs. Use sudo only when the first
# rm returns without effect.
for APP_NAME in "${APP_NAMES[@]}"; do
  for APP_DIR in "/Applications" "$HOME/Applications"; do
    TARGET="${APP_DIR}/${APP_NAME}.app"
    if [ -d "$TARGET" ]; then
      if rm -rf "$TARGET" 2>/dev/null && [ ! -d "$TARGET" ]; then
        echo "  removed ${TARGET}"
      else
        echo "  elevating to remove ${TARGET}…"
        sudo rm -rf "$TARGET"
      fi
    fi
  done
done

# 5. TCC prompts: macOS caches Screen Recording / Accessibility grants
# by bundle id. Fresh reinstall from a different signing identity would
# prompt again anyway, but reset the entries for cleanliness. Requires
# admin; skip silently if user declines.
for BUNDLE_ID in "${BUNDLE_IDS[@]}"; do
  tccutil reset ScreenCapture "$BUNDLE_ID"      2>/dev/null || true
  tccutil reset Accessibility "$BUNDLE_ID"      2>/dev/null || true
  tccutil reset SystemPolicyAllFiles "$BUNDLE_ID" 2>/dev/null || true
done

echo
echo "Done. Reboot recommended to release macOS TCC + Login Item caches."
