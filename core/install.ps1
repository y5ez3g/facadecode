[CmdletBinding()]
param(
    [string] $Version,
    [string] $Package,
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'Facade'),
    [switch] $NoPath,
    [switch] $NoActivate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
$versionPattern = '[0-9]+\.[0-9]+\.[0-9]+'
if ($PSBoundParameters.ContainsKey('Version') -and $Version -notmatch "\A$versionPattern\z") {
    throw 'Use a release version such as 0.1.6.'
}
if ($InstallRoot -notmatch '^[a-zA-Z]:[/\\]') {
    throw 'The install root must be an absolute path on a local drive.'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
# Select the host's package even when Windows PowerShell is running under emulation.
$processor = Get-CimInstance -ClassName Win32_Processor -Property Architecture | Select-Object -First 1
$arch = switch ($processor.Architecture) {
    9 { 'x64' }
    12 { 'arm64' }
    default { throw 'Facade is available for Windows on x64 and arm64.' }
}
$releases = 'https://github.com/y5ez3g/facadecode/releases'
$mirror = 'https://facadecode.com'
$asset = "facade-core-win32-$arch.zip"
$programs = @('facade.exe', 'facade-mcp.exe', 'conpty\conpty.dll', 'conpty\OpenConsole.exe')
$bin = Join-Path $InstallRoot 'bin'
$versions = Join-Path $InstallRoot 'versions'
$work = Join-Path $versions ('.install-' + [guid]::NewGuid())
$next = Join-Path $work 'next'
$previous = Join-Path $work 'previous'

function Read-Version {
    param([string] $File, [string] $InvalidMessage)

    $record = [regex]::Match([IO.File]::ReadAllText($File), "\A($versionPattern)(?:\r?\n)?\z")
    if (-not $record.Success) { throw $InvalidMessage }
    $record.Groups[1].Value
}

function Get-Download {
    param([string] $Url, [string] $Destination)

    $status = & curl.exe --disable --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 `
        -fsL -w '%{http_code}' -o $Destination $Url
    $LASTEXITCODE -eq 0 -and $status -match '\A2[0-9]{2}\z'
}

function Get-ReleasePackage {
    param([string] $Origin)

    (Get-Download "$Origin/$asset" $archive) -and (Get-Download "$Origin/SHA256SUMS" $checksums)
}

function Add-FacadePath {
    param([string] $Directory)

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $userPath = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($Directory -notin ([Environment]::ExpandEnvironmentVariables($userPath) -split ';')) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
            $key.SetValue('Path', (($userPath.TrimEnd(';'), $Directory | Where-Object { $_ }) -join ';'), $kind)
            # Explorer reloads user environment when it receives WM_SETTINGCHANGE.
            if (-not ('FacadeInstall.Environment' -as [type])) {
                Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace FacadeInstall {
    public static class Environment {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam,
            string text, uint flags, uint timeout, out IntPtr result);
        public static void Notify() {
            IntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001a, IntPtr.Zero, "Environment", 2, 1000, out result);
        }
    }
}
'@
            }
            [FacadeInstall.Environment]::Notify()
        }
    } finally {
        $key.Dispose()
    }
    if ($Directory -notin ($env:Path -split ';')) {
        $env:Path = "$env:Path;$Directory"
    }
}

[void][IO.Directory]::CreateDirectory($work)
try {
    $archive = Join-Path $work $asset
    $checksums = Join-Path $work 'SHA256SUMS'
    if ($Package) {
        $source = Get-Item -LiteralPath $Package
        Copy-Item -LiteralPath $source.FullName -Destination $archive
        Copy-Item -LiteralPath (Join-Path $source.DirectoryName 'SHA256SUMS') -Destination $checksums
    } else {
        if (-not $Version) {
            $versionFile = Join-Path $work 'latest-version'
            if (-not (Get-Download "$releases/latest/download/facade-core-version.txt" $versionFile) -and
                -not (Get-Download "$mirror/facade-core-version.txt" $versionFile)) {
                throw 'Could not download the stable Facade version from GitHub or facadecode.com.'
            }
            $Version = Read-Version $versionFile 'The stable release did not provide a valid version.'
        }
        if (-not (Get-ReleasePackage "$releases/download/extension%2F$Version") -and
            -not (Get-ReleasePackage "$mirror/releases/$Version")) {
            throw "Could not download $asset and its checksums for Facade $Version from GitHub or facadecode.com."
        }
    }
    $expected = @(Get-Content -LiteralPath $checksums | ForEach-Object {
        $record = [regex]::Match($_, '\A([0-9a-fA-F]{64})  (\S+)\z')
        if (-not $record.Success) { throw "SHA-256 verification failed for $asset." }
        if ($record.Groups[2].Value -ceq $asset) { $record.Groups[1].Value }
    })
    if ($expected.Count -ne 1 -or $expected[0] -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash) {
        throw "SHA-256 verification failed for $asset."
    }

    $stage = Join-Path $work 'payload'
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    $build = Read-Version (Join-Path $stage 'VERSION') 'The package did not provide a valid version.'
    if ($Version -and $build -cne $Version) { throw "Expected Facade $Version, found $build in the package." }
    foreach ($program in $programs) {
        if (-not [IO.File]::Exists((Join-Path $stage $program))) { throw "The package has no $program." }
    }
    $destination = Join-Path $versions $build
    if ([IO.Directory]::Exists($destination)) {
        foreach ($program in $programs) {
            $incoming = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $program)).Hash
            $installed = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $destination $program)).Hash
            if ($incoming -ne $installed) {
                throw "Facade $build already exists with different files in $destination."
            }
        }
    } else {
        [IO.Directory]::Move($stage, $destination)
    }

    $existing = Get-Item -LiteralPath $bin -Force -ErrorAction SilentlyContinue
    if ($existing -and ($existing.LinkType -ne 'Junction' -or (Split-Path -Parent (@($existing.Target)[0])) -ne $versions)) {
        throw "$bin is already used by another installation. Move it first."
    }
    $upToDate = $existing -and (@($existing.Target)[0] -eq $destination)
    if (-not $upToDate) {
        New-Item -ItemType Junction -Path $next -Target $destination | Out-Null
    }

    if (-not $NoActivate) {
        & (Join-Path $destination 'facade.exe') daemon --takeover
        if ($LASTEXITCODE -ne 0) { throw "Facade $build could not take over the running service (exit $LASTEXITCODE)." }
    }

    # Switch the junction without writing over an executable or ConPTY file in use.
    if (-not $upToDate) {
        if ($existing) { [IO.Directory]::Move($bin, $previous) }
        try {
            [IO.Directory]::Move($next, $bin)
        } catch {
            if ($existing) { [IO.Directory]::Move($previous, $bin) }
            throw
        }
    }
    if (-not $NoPath) { Add-FacadePath $bin }
} finally {
    # Windows PowerShell's recursive removal can fail on a junction to a version in use.
    foreach ($junction in $next, $previous) {
        if ([IO.Directory]::Exists($junction)) { [IO.Directory]::Delete($junction) }
    }
    if ([IO.Directory]::Exists($work)) { [IO.Directory]::Delete($work, $true) }
}
if ($upToDate -and $env:FACADE_UPGRADE_REPORT -eq '1') {
    Write-Output "Facade $build is already up to date in $bin."
} else {
    Write-Output "Installed Facade $build in $bin."
}
if (-not $NoPath) { Write-Output 'Open a new terminal if your shell has an older PATH.' }
