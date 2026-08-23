Write-Host "=== Driver Manager Pro ==="
pnputil /scan-devices
Write-Host "Devices with issues:"
Get-PnpDevice | Where-Object {$_.Status -ne "OK"} | Format-Table -AutoSize

if(Get-Module -ListAvailable PSWindowsUpdate){
 Import-Module PSWindowsUpdate
 Get-WindowsUpdate -MicrosoftUpdate -Category Drivers -Install -AcceptAll -IgnoreReboot
}else{
 Write-Host "PSWindowsUpdate module not installed."
 Write-Host "Install once: Install-Module PSWindowsUpdate -Scope CurrentUser"
}

pnputil /scan-devices

Get-CimInstance Win32_PnPSignedDriver |
Select DeviceName,DriverVersion,Manufacturer,DriverDate |
Export-Csv "$PSScriptRoot\InstalledDrivers.csv" -NoTypeInformation

Write-Host "Completed."
