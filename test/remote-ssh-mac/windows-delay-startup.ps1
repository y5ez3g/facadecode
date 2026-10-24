# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

param(
	[Parameter(Mandatory=$true)][ValidateSet('Enable','Restore')][string]$Action,
	[Parameter(Mandatory=$true)][string]$Launcher,
	[ValidateRange(1000,20000)][int]$DelayMilliseconds=5000
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$path=[IO.Path]::GetFullPath($Launcher)
if(!$path.StartsWith('C:\fssh24-a447\server-data',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($path) -ne 'facade-server.cmd') {
	throw 'Only the campaign''s isolated installed server launcher may be delayed.'
}
$backup=Join-Path ([IO.Path]::GetDirectoryName($path)) 'facade-server.startup-delay-original.cmd'
$state=$backup+'.json'
if($Action -eq 'Enable') {
	if(Test-Path $backup) { throw 'A startup delay is already installed; restore it first.' }
	$hash=(Get-FileHash $path -Algorithm SHA256).Hash
	Copy-Item -LiteralPath $path -Destination $backup
	[IO.File]::WriteAllText($state,(@{originalHash=$hash;launcher=$path;delayMilliseconds=$DelayMilliseconds}|ConvertTo-Json))
	# This is a real scheduling delay before the unmodified real launcher runs.
	# It fabricates no server, response, process identity or readiness output.
	$wrapper="@echo off`r`npowershell.exe -NoLogo -NoProfile -NonInteractive -Command `"Start-Sleep -Milliseconds $DelayMilliseconds`"`r`ncall `"%~dp0facade-server.startup-delay-original.cmd`" %*`r`nexit /b %errorlevel%`r`n"
	[IO.File]::WriteAllText($path,$wrapper,[Text.Encoding]::ASCII)
	Write-Output ('REAL_SERVER_STARTUP_DELAY_ENABLED_MS='+$DelayMilliseconds)
} else {
	if(!(Test-Path $backup) -or !(Test-Path $state)) { throw 'No recorded startup-delay backup exists.' }
	$before=Get-Content -Raw $state | ConvertFrom-Json
	if((Get-FileHash $backup -Algorithm SHA256).Hash -ne $before.originalHash) { throw 'Original launcher backup changed; refusing restoration.' }
	Copy-Item -LiteralPath $backup -Destination $path -Force
	if((Get-FileHash $path -Algorithm SHA256).Hash -ne $before.originalHash) { throw 'Restored launcher hash does not match.' }
	Remove-Item -LiteralPath $backup,$state
	Write-Output 'REAL_SERVER_LAUNCHER_RESTORED_BYTE_FOR_BYTE'
}
