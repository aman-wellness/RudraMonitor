# Windows Optimizer — deep cleanup of caches, old Windows Update files,
# superseded components, browser caches, delivery optimization data, crash
# dumps, and prior-install remnants.
#
# Output philosophy: every step prints the megabytes it freed so the admin's
# dashboard shows concrete proof the script ran ON the machine (not just a
# cached "Succeeded"). Total bytes freed + before/after free-space delta are
# printed at the end.

$ErrorActionPreference = "SilentlyContinue"
$log = Join-Path $PSScriptRoot "Logs\Cleanup_Report.txt"
$logDir = Split-Path $log
if(-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
"Cleanup started: $(Get-Date)" | Out-File $log

function Log($m) { $m | Out-File $log -Append }
function Size-Of-Path($p) {
  if(-not (Test-Path $p)) { return 0 }
  try {
    (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
  } catch { 0 }
}
function Format-MB($bytes) {
  if($null -eq $bytes -or $bytes -le 0) { return "0.0 MB" }
  return "{0:N1} MB" -f ($bytes / 1MB)
}
function Purge-Dir($path) {
  if(-not (Test-Path $path)) { return 0 }
  $before = Size-Of-Path $path
  Get-ChildItem -LiteralPath $path -Force -Recurse -ErrorAction SilentlyContinue |
    Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
  $after = Size-Of-Path $path
  $freed = [Math]::Max(0, $before - $after)
  return $freed
}

$sysDrive = ($env:SystemDrive)
if(-not $sysDrive) { $sysDrive = "C:" }
$freeBefore = (Get-PSDrive -Name $sysDrive.TrimEnd(':')).Free
Write-Host "Free space before cleanup: $(Format-MB $freeBefore)"
Log "Free space before: $(Format-MB $freeBefore)"

$totalFreed = 0

# --- Temporary files (system + all user profiles + Prefetch) ---
Write-Host "Cleaning temporary files..."
$tempPaths = @(
  $env:TEMP,
  "C:\Windows\Temp",
  "C:\Windows\Prefetch"
)
# Every real user profile's %TEMP% too (agent runs as SYSTEM in fleet, so
# $env:TEMP only covers SYSTEM's temp — the huge caches live in each user's
# AppData\Local\Temp).
Get-ChildItem "C:\Users" -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @("Public","Default","Default User","All Users") } |
  ForEach-Object {
    $userTemp = Join-Path $_.FullName "AppData\Local\Temp"
    if(Test-Path $userTemp) { $tempPaths += $userTemp }
  }
$freed = 0
foreach($p in $tempPaths) { $freed += Purge-Dir $p }
Write-Host "  Freed: $(Format-MB $freed)"
Log "Temporary files freed: $(Format-MB $freed)"
$totalFreed += $freed

# --- Recycle Bin (all drives, all users) ---
Write-Host "Emptying recycle bin..."
$binBefore = 0
Get-ChildItem -Path "$sysDrive\`$Recycle.Bin" -Recurse -Force -ErrorAction SilentlyContinue |
  ForEach-Object { $binBefore += $_.Length }
try { Clear-RecycleBin -Force -ErrorAction Stop } catch { }
$binAfter = 0
Get-ChildItem -Path "$sysDrive\`$Recycle.Bin" -Recurse -Force -ErrorAction SilentlyContinue |
  ForEach-Object { $binAfter += $_.Length }
$freed = [Math]::Max(0, $binBefore - $binAfter)
Write-Host "  Freed: $(Format-MB $freed)"
Log "Recycle bin freed: $(Format-MB $freed)"
$totalFreed += $freed

# --- Windows Update cache + Delivery Optimization + old Windows.old ---
Write-Host "Cleaning Windows Update cache..."
Stop-Service wuauserv -Force -ErrorAction SilentlyContinue
Stop-Service bits -Force -ErrorAction SilentlyContinue
Stop-Service DoSvc -Force -ErrorAction SilentlyContinue
$freed  = Purge-Dir "C:\Windows\SoftwareDistribution\Download"
$freed += Purge-Dir "C:\Windows\SoftwareDistribution\DataStore\Logs"
$freed += Purge-Dir "C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization"
$freed += Purge-Dir "C:\ProgramData\Microsoft\Network\Downloader"
# C:\Windows.old is the previous Windows install left by feature-updates.
# Can be 20-40 GB. Only safe to purge — Windows never re-uses it after 10 days
# and the OS has its own scheduled task that does the same purge after 30 days.
if(Test-Path "C:\Windows.old") {
  Write-Host "  Removing C:\Windows.old (previous Windows install)..."
  $freed += Purge-Dir "C:\Windows.old"
  try { Remove-Item "C:\Windows.old" -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
Start-Service bits -ErrorAction SilentlyContinue
Start-Service wuauserv -ErrorAction SilentlyContinue
Start-Service DoSvc -ErrorAction SilentlyContinue
Write-Host "  Freed: $(Format-MB $freed)"
Log "Windows Update / DO / Windows.old freed: $(Format-MB $freed)"
$totalFreed += $freed

# --- Browser caches (Chrome, Edge, Firefox, Brave) for every user ---
Write-Host "Browser cache cleanup..."
$freed = 0
Get-ChildItem "C:\Users" -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @("Public","Default","Default User","All Users") } |
  ForEach-Object {
    $local = Join-Path $_.FullName "AppData\Local"
    $roaming = Join-Path $_.FullName "AppData\Roaming"
    # Chrome-family: iterate every profile (Default, Profile 1, Profile 2, ...)
    foreach($browser in @("Google\Chrome","Microsoft\Edge","BraveSoftware\Brave-Browser","Chromium")) {
      $ud = Join-Path $local "$browser\User Data"
      if(Test-Path $ud) {
        Get-ChildItem $ud -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq "Default" -or $_.Name -like "Profile *" } |
          ForEach-Object {
            foreach($sub in @("Cache","Code Cache","GPUCache","Media Cache","ShaderCache","Service Worker\CacheStorage")) {
              $freed += Purge-Dir (Join-Path $_.FullName $sub)
            }
          }
      }
    }
    # Firefox profiles
    $ffProfiles = Join-Path $roaming "Mozilla\Firefox\Profiles"
    if(Test-Path $ffProfiles) {
      Get-ChildItem $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        foreach($sub in @("cache2","startupCache","shader-cache")) {
          $freed += Purge-Dir (Join-Path $_.FullName $sub)
        }
      }
    }
    # Legacy IE cache still on many corporate machines
    $freed += Purge-Dir (Join-Path $local "Microsoft\Windows\INetCache")
    $freed += Purge-Dir (Join-Path $local "Microsoft\Windows\WebCache")
  }
Write-Host "  Freed: $(Format-MB $freed)"
Log "Browser caches freed: $(Format-MB $freed)"
$totalFreed += $freed

# --- Crash dumps, error reports, event log old files ---
Write-Host "Cleaning crash dumps and error reports..."
$freed = 0
$freed += Purge-Dir "C:\Windows\Minidump"
$freed += Purge-Dir "C:\Windows\LiveKernelReports"
$freed += Purge-Dir "C:\ProgramData\Microsoft\Windows\WER\ReportQueue"
$freed += Purge-Dir "C:\ProgramData\Microsoft\Windows\WER\ReportArchive"
$freed += Purge-Dir "C:\ProgramData\Microsoft\Windows\WER\Temp"
Get-ChildItem "C:\Users" -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @("Public","Default","Default User","All Users") } |
  ForEach-Object {
    $freed += Purge-Dir (Join-Path $_.FullName "AppData\Local\CrashDumps")
    $freed += Purge-Dir (Join-Path $_.FullName "AppData\Local\Microsoft\Windows\WER")
  }
# Old CBS logs (component-based servicing) — can accumulate to 5+ GB
Get-ChildItem "C:\Windows\Logs\CBS" -Filter "*.log" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  ForEach-Object { $freed += $_.Length; Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
Get-ChildItem "C:\Windows\Logs\CBS" -Filter "*.cab" -ErrorAction SilentlyContinue |
  ForEach-Object { $freed += $_.Length; Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
Write-Host "  Freed: $(Format-MB $freed)"
Log "Crash dumps + old CBS logs freed: $(Format-MB $freed)"
$totalFreed += $freed

# --- Component cleanup with ResetBase for deep purge of superseded WU files ---
Write-Host "Component cleanup (removes superseded Windows Update files)..."
$compBefore = Size-Of-Path "C:\Windows\WinSxS"
# /StartComponentCleanup /ResetBase removes ALL superseded versions permanently.
# Cannot be undone (uninstall of prior WU patches becomes impossible after) but
# on a stable production endpoint that's the correct trade-off. Frees 3-15 GB.
DISM /Online /Cleanup-Image /StartComponentCleanup /ResetBase | Out-Null
$compAfter = Size-Of-Path "C:\Windows\WinSxS"
$freed = [Math]::Max(0, $compBefore - $compAfter)
Write-Host "  Freed: $(Format-MB $freed)"
Log "Component cleanup freed: $(Format-MB $freed)"
$totalFreed += $freed

# sfc /scannow, DISM /RestoreHealth and chkdsk /scan removed 2026-09-02:
# repair operations, not routine cleanup. Admin with a corrupted system
# should run a dedicated deep-repair tool with its own longer timeout.
# Keeping Optimizer to actual cleanup lets a full run finish inside ~15 min
# on a machine with 20+ GB of accumulated junk.

# --- Volume optimize (TRIM for SSD / Defrag for HDD) ---
Write-Host "Optimizing drive..."
$disk = Get-Volume -DriveLetter ($sysDrive.TrimEnd(':'))
if($disk.DriveType -eq 'Fixed') {
  try {
    Optimize-Volume -DriveLetter ($sysDrive.TrimEnd(':')) -ReTrim -ErrorAction Stop
    Write-Host "  ReTrim complete (SSD)"
    Log "SSD ReTrim complete"
  } catch {
    Optimize-Volume -DriveLetter ($sysDrive.TrimEnd(':')) -Defrag
    Write-Host "  Defrag complete (HDD)"
    Log "HDD Defrag complete"
  }
}

# Explorer restart skipped: killing explorer mid-session closes the user's
# desktop, open windows, tray icons. Hard NO for a background-triggered run.

# --- Summary ---
$freeAfter = (Get-PSDrive -Name $sysDrive.TrimEnd(':')).Free
$deltaFree = $freeAfter - $freeBefore
Write-Host ""
Write-Host "===== SUMMARY ====="
Write-Host "Total freed by cleanup steps: $(Format-MB $totalFreed)"
Write-Host "Free space delta on $sysDrive : $(Format-MB $deltaFree)"
Write-Host "Free space now: $(Format-MB $freeAfter)"
Write-Host ""
Write-Host "Done. Report saved to Logs\Cleanup_Report.txt"
Write-Host "Passwords, bookmarks and saved logins were NOT touched."

Log ""
Log "===== SUMMARY ====="
Log "Total freed by cleanup steps: $(Format-MB $totalFreed)"
Log "Free space delta: $(Format-MB $deltaFree)"
Log "Free space after: $(Format-MB $freeAfter)"
Log "Completed: $(Get-Date)"
