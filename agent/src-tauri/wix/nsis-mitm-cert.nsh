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

!macro NSIS_HOOK_POSTINSTALL
  ; -addstore Root without -user goes to HKLM\...\SystemCertificates\Root
  ; (needs admin, which perMachine install already has). -f overwrites
  ; a stale copy on upgrade. Silent — no per-cert dialog.
  ExecWait 'certutil.exe -f -addstore Root "$INSTDIR\resources\mitm-ca.crt"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; -delstore accepts the CA's Subject CN as the filter, so we don't
  ; need the serial number. Removes any anchor whose Subject matches
  ; the string — safe because only our CA carries this CN.
  ExecWait 'certutil.exe -delstore Root "Wellness Extract Root CA"'
!macroend
