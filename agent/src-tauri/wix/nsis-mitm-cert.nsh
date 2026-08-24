; nsis-mitm-cert.nsh — Tauri NSIS installer hook for the Email DLP MITM
; anchor (v0.7.0+).
;
; NSIS is per-user (installMode: currentUser in tauri.conf.json), so
; the CA lands in the CURRENT USER's Trusted Root store — trusted by
; Chrome / Edge for that user, which is the only session the local
; proxy will ever see traffic from. Firefox uses NSS (its own cert
; store) and is handled by the agent at first-run.
;
; The MSI/WiX bundle installs the same cert into LocalMachine\Root
; (see wix/service-fragment.wxs). MDM-pushed installs use the MSI, so
; the machine-wide anchor covers every user on that box.
;
; NSIS's single-quoted strings do NOT support the '' escape convention
; PowerShell uses — that broke the v0.7.0 build. Both install and
; uninstall use `certutil.exe` directly with plain quotes so the whole
; command is one clean shell invocation.

!macro NSIS_HOOK_POSTINSTALL
  ; certutil.exe ships on every supported Windows (10 / 11).
  ; -user scopes the write to HKCU\...\SystemCertificates\Root (no admin).
  ; -f overwrites a stale copy on upgrade.
  ExecWait 'certutil.exe -user -f -addstore Root "$INSTDIR\resources\mitm-ca.crt"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; -delstore accepts the CA's Subject CN as the filter, so we don't
  ; need the serial number. Removes any anchor whose Subject matches
  ; the string — safe because only our CA carries this CN.
  ExecWait 'certutil.exe -user -delstore Root "Wellness Extract Root CA"'
!macroend
