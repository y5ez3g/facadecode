# Cargo runs the doctest executable through this wrapper after rustdoc links it.
param(
	[Parameter(Mandatory = $true)][string]$Scope,
	[Parameter(Mandatory = $true)][string]$Program,
	[Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArguments
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Scope) -or -not (Test-Path -LiteralPath $Scope -PathType Container)) {
	throw 'The doctest needs an existing, absolute test scope.'
}
$profile_ = Join-Path $Scope 'home'
$env:USERPROFILE = $profile_
$env:HOME = $profile_
$env:APPDATA = Join-Path $profile_ 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $profile_ 'AppData\Local'
$env:FACADE_HOME = Join-Path $profile_ '.facade'
$env:TMP = $Scope
$env:TEMP = $Scope
$env:TMPDIR = $Scope
& $Program @TestArguments
exit $LASTEXITCODE
