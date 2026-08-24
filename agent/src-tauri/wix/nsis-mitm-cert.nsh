; nsis-mitm-cert.nsh — Tauri NSIS installer hook for the Email DLP MITM
; anchor (v0.7.2+).
;
; NSIS runs perMachine (see tauri.conf.json bundle.windows.nsis.installMode)
; so the installer already ran an elevation UAC prompt. certutil below
; therefore has admin rights and writes to LocalMachine\Root — every
; user on this box trusts the anchor and Windows does NOT show the
; per-certificate security dialog that -user Root writes would trigger.
;
; The MSI/WiX bundle mirrors this via WiX CustomAction (SYSTEM context).
;
; NSIS's single-quoted strings do NOT support the '' escape convention
; PowerShell uses — that broke the v0.7.0 build. Both install and
; uninstall use certutil.exe directly with plain quotes so the whole
; command is one clean shell invocation.

; nsExec::Exec runs the child WITHOUT a console window; ExecWait
; would let certutil.exe flash its own black CMD window on the user's
; desktop during install (very visible on updater-triggered
; background upgrades). SetDetailsPrint none also silences NSIS's
; own log-lines popup even when the installer itself is running
; under /S silent mode.

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsPrint none
  nsExec::Exec 'certutil.exe -f -addstore Root "$INSTDIR\resources\mitm-ca.crt"'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetDetailsPrint none
  nsExec::Exec 'certutil.exe -delstore Root "Wellness Extract Root CA"'
  Pop $0
!macroend
