#!/usr/bin/env bash
# Build a signed .pkg installer for macOS that ships:
#   - /Applications/Rudrans Agent.app                 (the agent itself, hidden after enroll)
#   - /Applications/Uninstall Rudrans Agent.app       (double-click to fully uninstall)
#
# Why a .pkg + companion uninstaller .app?
# macOS doesn't run "uninstall hooks" when a user drags an .app to Trash. The standard
# way to deliver "one-click uninstall" is to ship a separate uninstaller that the user
# runs once. .pkg lets us deploy both via MDM (Jamf/Intune) or manual install.
#
# Output: dist-mac/Rudrans-Agent-<version>.pkg
#
# Optional signing:
#   DEVELOPER_ID_INSTALLER="Developer ID Installer: Acme Inc (TEAMID)" ./build-mac-pkg.sh
#   (leave unset for an unsigned dev build)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Rudrans Agent"
BUNDLE_ID="com.rudrans.agent"
UNINSTALLER_BUNDLE_ID="com.rudrans.agent.uninstaller"
VERSION="$(node -p "require('${ROOT}/src-tauri/tauri.conf.json').version")"

OUT_DIR="${ROOT}/dist-mac"
STAGE="${OUT_DIR}/stage"
SCRIPTS_DIR="${OUT_DIR}/scripts"

echo "==> cleaning previous build"
rm -rf "${OUT_DIR}"
mkdir -p "${STAGE}/Applications" "${SCRIPTS_DIR}"

echo "==> building the Tauri .app (release)"
( cd "${ROOT}" && npm run tauri build -- --bundles app )

BUILT_APP="${ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
if [ ! -d "${BUILT_APP}" ]; then
  echo "ERROR: built app not found at ${BUILT_APP}" >&2
  exit 1
fi

echo "==> staging ${APP_NAME}.app → /Applications"
cp -R "${BUILT_APP}" "${STAGE}/Applications/${APP_NAME}.app"

echo "==> generating Uninstall ${APP_NAME}.app"
UNINSTALLER_SRC="${OUT_DIR}/uninstaller.applescript"
cat > "${UNINSTALLER_SRC}" <<APPLESCRIPT
-- Companion uninstaller. Asks for confirmation, then runs the same cleanup logic the
-- agent's --uninstall flag does (LaunchAgent plist, app support data, both app bundles).
set theMessage to "Uninstall Rudrans Agent? This will remove the agent, its autostart entry, and all locally stored data."
display dialog theMessage buttons {"Cancel", "Uninstall"} default button "Uninstall" with icon caution
do shell script "/Applications/${APP_NAME}.app/Contents/MacOS/${APP_NAME} --uninstall || true"
do shell script "rm -rf '/Applications/Uninstall ${APP_NAME}.app'" with administrator privileges
display dialog "Rudrans Agent has been removed." buttons {"OK"} default button "OK"
APPLESCRIPT

osacompile -o "${STAGE}/Applications/Uninstall ${APP_NAME}.app" "${UNINSTALLER_SRC}"

# Stamp a recognizable bundle id on the uninstaller so it's distinguishable in pkgutil/MDM.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${UNINSTALLER_BUNDLE_ID}" \
  "${STAGE}/Applications/Uninstall ${APP_NAME}.app/Contents/Info.plist" 2>/dev/null || true

echo "==> writing postinstall script (LaunchDaemon for service-level autostart + first launch)"
cat > "${SCRIPTS_DIR}/postinstall" <<'POSTINSTALL'
#!/bin/bash
# Two-stage install:
#   1. Drop a system-wide LaunchDaemon (root-owned) with KeepAlive=true so launchd
#      itself respawns the agent within ~5 seconds even if the employee force-quits
#      it from Activity Monitor or 'kill -9'. The plist also runs at boot so the
#      agent is always alive without anyone logging in.
#   2. Trigger a one-time GUI launch on the current user's session so the
#      enrollment dialog appears (post-enroll the window auto-hides forever).
#
# All paths and the plist itself are public — IT admins can audit / disable through
# normal launchctl commands. This is enterprise persistence, not a rootkit.

LABEL="com.rudrans.agent"
DAEMON_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
APP_BIN="/Applications/Rudrans Agent.app/Contents/MacOS/Rudrans Agent"

# Remove any older user-level LaunchAgent we may have installed previously
# (the autostart plugin would have written ~/Library/LaunchAgents/<label>.plist).
LOGGED_IN_USER=$(stat -f%Su /dev/console)
if [ -n "$LOGGED_IN_USER" ] && [ "$LOGGED_IN_USER" != "root" ]; then
  USER_HOME=$(eval echo "~$LOGGED_IN_USER")
  USER_PLIST="${USER_HOME}/Library/LaunchAgents/${LABEL}.plist"
  if [ -f "$USER_PLIST" ]; then
    sudo -u "$LOGGED_IN_USER" launchctl unload "$USER_PLIST" 2>/dev/null || true
    rm -f "$USER_PLIST"
  fi
fi

# Write LaunchDaemon plist. KeepAlive=true means launchd will restart the agent
# any time it exits (whether killed, crashed, or admin tried to stop it) until
# the daemon itself is unloaded by `launchctl unload`. ThrottleInterval=5 caps
# the respawn rate so a buggy build can't loop infinitely.
cat > "${DAEMON_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${APP_BIN}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/var/log/rudrans-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/rudrans-agent.log</string>
</dict>
</plist>
PLIST

chown root:wheel "${DAEMON_PLIST}"
chmod 644 "${DAEMON_PLIST}"

# Load the daemon — this both registers it with launchd and starts it immediately.
launchctl load -w "${DAEMON_PLIST}" 2>/dev/null || true

# Also pop the GUI on the user's session for first-time enrollment. Once enrolled,
# the agent hides itself and the daemon keeps it alive in the background.
if [ -n "$LOGGED_IN_USER" ] && [ "$LOGGED_IN_USER" != "root" ]; then
  sudo -u "$LOGGED_IN_USER" open -a "/Applications/Rudrans Agent.app" || true
fi
exit 0
POSTINSTALL
chmod 755 "${SCRIPTS_DIR}/postinstall"

echo "==> building component .pkg"
COMPONENT_PKG="${OUT_DIR}/component.pkg"
pkgbuild \
  --root "${STAGE}" \
  --identifier "${BUNDLE_ID}" \
  --version "${VERSION}" \
  --install-location "/" \
  --scripts "${SCRIPTS_DIR}" \
  "${COMPONENT_PKG}"

echo "==> building distribution .pkg"
DIST_XML="${OUT_DIR}/distribution.xml"
cat > "${DIST_XML}" <<DIST
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>${APP_NAME}</title>
  <organization>${BUNDLE_ID}</organization>
  <domains enable_localSystem="true"/>
  <options customize="never" require-scripts="true" rootVolumeOnly="true"/>
  <choices-outline>
    <line choice="default">
      <line choice="${BUNDLE_ID}"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="${BUNDLE_ID}" visible="false">
    <pkg-ref id="${BUNDLE_ID}"/>
  </choice>
  <pkg-ref id="${BUNDLE_ID}" version="${VERSION}" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
DIST

FINAL_PKG="${OUT_DIR}/Rudrans-Agent-${VERSION}.pkg"

if [ -n "${DEVELOPER_ID_INSTALLER:-}" ]; then
  echo "==> signing with: ${DEVELOPER_ID_INSTALLER}"
  productbuild \
    --distribution "${DIST_XML}" \
    --package-path "${OUT_DIR}" \
    --sign "${DEVELOPER_ID_INSTALLER}" \
    "${FINAL_PKG}"
else
  echo "==> productbuild (UNSIGNED — set DEVELOPER_ID_INSTALLER env to sign)"
  productbuild \
    --distribution "${DIST_XML}" \
    --package-path "${OUT_DIR}" \
    "${FINAL_PKG}"
fi

echo
echo "Done."
echo "  Installer: ${FINAL_PKG}"
echo
echo "Install:    sudo installer -pkg \"${FINAL_PKG}\" -target /"
echo "Uninstall:  double-click /Applications/Uninstall\\ ${APP_NAME}.app"
