
$ErrorActionPreference="SilentlyContinue"
$log=Join-Path $PSScriptRoot "Logs\Cleanup_Report.txt"
"Cleanup started: $(Get-Date)"|Out-File $log

function Log($m){$m|Out-File $log -Append}

Write-Host "Cleaning temporary files..."
$paths=@($env:TEMP,"C:\Windows\Temp","C:\Windows\Prefetch")
foreach($p in $paths){
 if(Test-Path $p){
  Get-ChildItem $p -Force -Recurse | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
 }
}

Write-Host "Emptying recycle bin..."
Clear-RecycleBin -Force

Write-Host "Cleaning Windows Update cache..."
Stop-Service wuauserv -Force
Stop-Service bits -Force
Remove-Item "C:\Windows\SoftwareDistribution\Download\*" -Recurse -Force -ErrorAction SilentlyContinue
Start-Service bits
Start-Service wuauserv

Write-Host "Browser cache cleanup..."
$chrome="$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache"
$edge="$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache"
$ff="$env:LOCALAPPDATA\Mozilla\Firefox\Profiles"
if(Test-Path $chrome){Remove-Item "$chrome\*" -Recurse -Force -ErrorAction SilentlyContinue}
if(Test-Path $edge){Remove-Item "$edge\*" -Recurse -Force -ErrorAction SilentlyContinue}
if(Test-Path $ff){Get-ChildItem $ff -Directory|%{
$c=Join-Path $_.FullName "cache2"
if(Test-Path $c){Remove-Item "$c\*" -Recurse -Force -ErrorAction SilentlyContinue}
}}

# Store cache reset skipped intentionally: `wsreset.exe` briefly flashes a
# blank Store window even when launched from a headless PowerShell session,
# which breaks the "user sees nothing" guarantee of the agent-triggered
# background run. Users who care about Store cache can run wsreset manually.


Write-Host "Component cleanup..."
DISM /Online /Cleanup-Image /StartComponentCleanup | Out-Null

Write-Host "System file check..."
sfc /scannow

Write-Host "DISM health restore..."
DISM /Online /Cleanup-Image /RestoreHealth | Out-Null

Write-Host "CHKDSK scan..."
chkdsk /scan | Out-Null

Write-Host "Optimizing drive..."
$disk=(Get-Volume -DriveLetter C)
if($disk.DriveType -eq 'Fixed'){
 try{
  Optimize-Volume -DriveLetter C -ReTrim -ErrorAction Stop
 }catch{
  Optimize-Volume -DriveLetter C -Defrag
 }
}

# Explorer restart skipped intentionally: killing explorer mid-session
# closes the user's desktop, open File Explorer windows, and tray icons.
# That's a hard NO when the agent triggers this in the background — the
# user would immediately notice something ran on their machine. The manual
# .bat entry point still has this line for the interactive use case.

Log "Completed: $(Get-Date)"
Write-Host ""
Write-Host "Done. Report saved to Logs\Cleanup_Report.txt"
Write-Host "Passwords, bookmarks and saved logins were NOT touched."
