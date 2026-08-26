; nsis-mitm-cert.nsh — Tauri NSIS installer hook (v0.7.13+).
;
; Included at TOP LEVEL by the generated installer.nsi (before sections), so the
; CRCCheck directive below takes effect for the whole installer.
;
; CRCCheck off:
;   The Agent Setup download stamps the client's org license key into the ONE
;   shared installer by APPENDING a "{{WEZT-LICENSE}}<key>{{/WEZT-LICENSE}}"
;   footer to its bytes (nothing identifying ever goes in the filename). NSIS's
;   default integrity check would reject a file whose bytes changed after build,
;   so we disable it. The extra trailing bytes are ignored by NSIS extraction.
;
; Runs in the perMachine (elevated) installer, so everything here has admin
; rights. On install it:
;   1. Trusts the Email DLP MITM root CA (LocalMachine\Root).
;   2. Zero-touch enrolment: copies the whole installer (footer included) to
;      "enroll.dat" next to the exe. The agent parses the license key out of the
;      footer in Rust (robust byte scan — no fragile NSIS string parsing), enrols
;      with the PC hostname, then DELETES enroll.dat. Worldwide/multi-tenant: the
;      same installer works for every client, keyed only by the appended footer.
;   3. Registers the elevated logon Scheduled Task (so future auto-updates install
;      SILENTLY: the updater spawns the installer from an already-elevated process
;      → no UAC prompt) and RUNS it immediately, so the agent's very first boot is
;      elevated — that lets it both enrol and delete enroll.dat from Program Files.
;
; nsExec::Exec runs children without a console window; SetDetailsPrint none
; silences NSIS's own popup even under /S. Single-quoted strings do not support
; PowerShell '' escaping — plain quotes throughout.

CRCCheck off

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsPrint none

  ; --- 1. MITM root CA ---
  nsExec::Exec 'certutil.exe -f -addstore Root "$INSTDIR\resources\mitm-ca.crt"'
  Pop $0

  ; --- 2. Copy the stamped installer so the agent can read the license footer ---
  ; $EXEPATH is the full path of the running (downloaded) installer, footer and
  ; all. CopyFiles /SILENT avoids a progress dialog under the quiet install.
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\enroll.dat"

  ; --- 3. Elevated logon task = silent auto-updates; run it now = elevated boot ---
  nsExec::Exec 'schtasks /create /f /sc onlogon /rl highest /it /tn "WellnessExtractAgent" /tr "\"$INSTDIR\wellness-extract-agent.exe\""'
  Pop $0
  nsExec::Exec 'schtasks /run /tn "WellnessExtractAgent"'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetDetailsPrint none

  ; --- 1. Full agent-driven cleanup FIRST ---
  ;
  ; Call the currently-installed agent binary with --uninstall before we
  ; touch anything ourselves. windows_uninstall_self() (agent/src-tauri/
  ; src/lib.rs) walks C:\Users\* and HKEY_USERS\<SID>\* explicitly, so it
  ; wipes every real user's AppData, Run entries, MITM-proxy hijack, and
  ; the HKLM USB block policy — none of which NSIS can reach from
  ; the installer context alone. This is what makes the "normal .exe
  ; uninstall" (Add-or-Remove Programs) as thorough as the MSI/Intune
  ; path. Sync + short timeout so we don't stall the uninstaller if the
  ; agent binary is missing or wedged.
  ;
  ; NSIS is already elevated (perMachine); spawning the child inherits
  ; that, so windows_uninstall_self runs as SYSTEM/Admin and can touch
  ; HKLM + every user profile.
  nsExec::ExecToStack '"$INSTDIR\wellness-extract-agent.exe" --uninstall'
  Pop $0
  Pop $1

  ; --- 2. Belt-and-suspenders: even if step 1 failed, hit the biggest
  ;        leftovers directly from NSIS so an unbootable / corrupt exe
  ;        still can't leave residue behind. ---

  ; Kill any surviving agent + guardian across all sessions. /T tears
  ; down the whole tree (ffmpeg, rustdesk children too).
  nsExec::Exec 'taskkill.exe /F /T /IM wellness-extract-agent.exe'
  Pop $0
  nsExec::Exec 'taskkill.exe /F /T /IM "Security Assistant.exe"'
  Pop $0

  ; Both scheduled task names.
  nsExec::Exec 'schtasks.exe /Delete /F /TN "WellnessExtractAgent"'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /F /TN "\SecurityAssistant\Security Assistant"'
  Pop $0

  ; MITM root CA.
  nsExec::Exec 'certutil.exe -delstore Root "Wellness Extract Root CA"'
  Pop $0

  ; USB block Group Policy — nothing else clears this.
  nsExec::Exec 'reg.exe delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53F5630D-B6BF-11D0-94F2-00A0C91EFB8B}" /f'
  Pop $0

  ; Zero-touch enrolment carry-over + prefill.
  Delete "$INSTDIR\enroll.dat"
  Delete "$INSTDIR\prefill.json"
!macroend
