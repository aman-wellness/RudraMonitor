# install-service-windows.ps1
# Registers TrackForce Agent as a Windows service that auto-restarts on failure.
# Run from an elevated PowerShell. Idempotent — safe to re-run.
#
# Usage (after agent .msi install):
#   powershell -ExecutionPolicy Bypass -File install-service-windows.ps1
#
# Removal:
#   powershell -ExecutionPolicy Bypass -File install-service-windows.ps1 -Uninstall

[CmdletBinding()]
param([switch]$Uninstall)

$ServiceName = "TrackForceAgent"
$DisplayName = "TrackForce Workforce Agent"
$Description = "Background workforce productivity monitoring agent. Installed by IT admin per company policy."

# Default install paths (update if your MSI installs elsewhere)
$ExePath = Join-Path ${env:ProgramFiles} "TrackForce Agent\TrackForce Agent.exe"

if ($Uninstall) {
    Write-Host "Stopping and removing service $ServiceName..."
    sc.exe stop $ServiceName | Out-Null
    sc.exe delete $ServiceName | Out-Null
    Write-Host "Done."
    exit 0
}

if (-not (Test-Path $ExePath)) {
    Write-Error "Agent binary not found at $ExePath. Install the MSI first."
    exit 1
}

# Create the service. binPath wraps in quotes so spaces in path work.
sc.exe create $ServiceName binPath= "`"$ExePath`"" start= auto DisplayName= $DisplayName | Out-Null
sc.exe description $ServiceName $Description | Out-Null

# Restart configuration: on each failure, wait 5 seconds and restart.
# Reset the failure counter after 1 day. Three restart actions cover up to 3
# rapid kills in a session — after that the service waits, but the in-process
# guardian inside the agent itself takes over.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

# Run the failure actions even on graceful (non-zero) exit, so Task Manager
# kills also trigger restart.
sc.exe failureflag $ServiceName 1 | Out-Null

Write-Host "Starting service..."
sc.exe start $ServiceName | Out-Null

Write-Host ""
Write-Host "✅ TrackForce Agent service installed."
Write-Host "   Restart-on-kill is active (5-second delay between attempts)."
Write-Host "   In-process guardian watches the main process for instant respawn."
Write-Host ""
Write-Host "   To uninstall: powershell -ExecutionPolicy Bypass -File install-service-windows.ps1 -Uninstall"
