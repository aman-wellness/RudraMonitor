; nsis-mitm-cert.nsh — Tauri NSIS installer hook for the Email DLP MITM
; anchor (v0.7.0+).
;
; The NSIS build is per-user (installMode: currentUser in tauri.conf.json),
; so we install the CA into the CURRENT USER's Trusted Root store, not
; LocalMachine. That's still trusted by Chrome / Edge for THAT user's
; browsing profile — the only session the local proxy will ever see
; traffic from. Firefox uses NSS (its own cert store) and is handled by
; a separate hook when the proxy first starts (Phase 3).
;
; The MSI/WiX bundle installs the same cert into LocalMachine\Root
; (see wix/service-fragment.wxs). MDM-pushed installs use the MSI, so
; the machine-wide anchor covers every user on that box.

!macro NSIS_HOOK_POSTINSTALL
  ; certutil.exe is present on every supported Windows (10 / 11).
  ; -user scopes the write to HKCU\...\SystemCertificates\Root, which
  ; doesn't need admin. -f overwrites a stale copy on upgrade.
  ; The .crt lands at $INSTDIR\resources\mitm-ca.crt via bundle.resources.
  ExecWait 'certutil.exe -user -f -addstore Root "$INSTDIR\resources\mitm-ca.crt"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Delete the anchor by subject name so an upgrade that reinstalls it
  ; is still safe (we only remove OUR cert; anything else the user
  ; trusted stays). PowerShell filter matches on CN of our CA.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match ''Wellness Extract Root CA'' } | ForEach-Object { Remove-Item -Path $_.PSPath -Force -ErrorAction SilentlyContinue }"'
!macroend
