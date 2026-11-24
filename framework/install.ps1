[CmdletBinding()]
param(
    [string] $Version,
    [string] $Package,
    [string] $InstallRoot = $env:FACADE_HOME,
    [switch] $NoPath,
    [switch] $NoActivate,
    [string] $ExpectedBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
$versionPattern = '[0-9]+\.[0-9]+\.[0-9]+'
$buildPattern = "$versionPattern(?:\+(?:[0-9]+\.)?[0-9A-Za-z]+)?"
if ($PSBoundParameters.ContainsKey('Version') -and $Version -notmatch "\A$versionPattern\z") {
    throw 'Use a release version such as 0.1.6.'
}
if ($PSBoundParameters.ContainsKey('ExpectedBuild') -and $ExpectedBuild -cnotmatch "\A$buildPattern\z") {
    throw 'Use a valid Facade BUILD for -ExpectedBuild.'
}
if (-not $InstallRoot) {
    $profileHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
    $InstallRoot = [IO.Path]::Combine($profileHome, '.facade')
}
if ($InstallRoot -notmatch '^(?:[a-zA-Z]:[/\\]|\\\\[^\\]+\\[^\\]+)') {
    throw 'The Facade home must be an absolute path.'
}
# Select the host's package even when Windows PowerShell is running under emulation.
$processor = Get-CimInstance -ClassName Win32_Processor -Property Architecture | Select-Object -First 1
$arch = switch ($processor.Architecture) {
    9 { 'x64' }
    12 { 'arm64' }
    default { throw 'Facade is available for Windows on x64 and arm64.' }
}
$releases = 'https://github.com/y5ez3g/facadecode/releases'
$mirror = 'https://facadecode.com'
$asset = "facade-framework-win32-$arch.zip"
$programs = @('facade.exe', 'facade-mcp.exe', 'conpty\conpty.dll', 'conpty\OpenConsole.exe')
$bin = [IO.Path]::Combine($InstallRoot, 'framework', 'bin')
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
if ($temp.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a temporary directory outside the Facade home.'
}
$work = Join-Path $temp ('facade-install-' + [guid]::NewGuid())
$downloadFailure = @{ Asset = ''; Http = '-' }
$latestBuild = $null

function Read-Build {
    param([string] $File, [string] $InvalidMessage)

    if (-not [IO.File]::Exists($File)) { throw $InvalidMessage }
    $record = [regex]::Match([IO.File]::ReadAllText($File), "\A($buildPattern)(?:\r?\n)?\z")
    if (-not $record.Success) { throw $InvalidMessage }
    $record.Groups[1].Value
}

function Get-Download {
    param([string] $Url, [string] $Destination)

    $status = & curl.exe --disable --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 `
        -fsL -w '%{http_code}' -o $Destination $Url
    if ($LASTEXITCODE -eq 0 -and $status -match '\A2[0-9]{2}\z') { return $true }
    if ($status -match '\A[1-5][0-9]{2}\z') {
        $downloadFailure.Asset = $Url.Substring($Url.LastIndexOf('/') + 1)
        $downloadFailure.Http = $status
    } elseif ($downloadFailure.Http -eq '-') {
        $downloadFailure.Asset = $Url.Substring($Url.LastIndexOf('/') + 1)
    }
    return $false
}

function Get-ReleasePackage {
    param([string] $Origin)

    (Get-Download "$Origin/$asset" $archive) -and (Get-Download "$Origin/SHA256SUMS" $checksums)
}

function Write-DownloadFailure {
    if ($env:FACADE_UPGRADE_REPORT -eq '1' -and $env:FACADE_UPGRADE_ASSET_REPORT -eq '1') {
        Write-Output "facade-upgrade-asset-error $($downloadFailure.Asset) $($downloadFailure.Http)"
    }
}

function Get-LegacyInstall {
    if (-not $env:LOCALAPPDATA) { return }
    $legacy = Join-Path $env:LOCALAPPDATA 'Facade'
    $legacyBin = Join-Path $legacy 'bin'
    $legacyVersions = Join-Path $legacy 'versions'
    $entry = Get-Item -LiteralPath $legacyBin -Force -ErrorAction SilentlyContinue
    if (-not $entry) { return @{ Bin = $legacyBin } }
    $selected = @($entry.Target)[0]
    if ($entry.LinkType -ne 'Junction' -or -not $selected -or
        (Split-Path -Parent $selected) -ne $legacyVersions -or
        (Split-Path -Leaf $selected) -notmatch "\A$versionPattern\z") {
        return
    }

    foreach ($parent in $legacy, $legacyVersions) {
        $folder = Get-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        if (-not $folder -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    }
    return @{ Bin = $legacyBin; Root = $legacy; Versions = $legacyVersions }
}

function Remove-LegacyInstall {
    param([hashtable] $Legacy)

    [IO.Directory]::Delete($Legacy.Bin)
    foreach ($folder in Get-ChildItem -LiteralPath $Legacy.Versions -Directory -Force) {
        if ($folder.Name -notmatch "\A$versionPattern\z" -or
            ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        $marker = Join-Path $folder.FullName 'VERSION'
        if (-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker).TrimEnd("`r", "`n") -ne $folder.Name) { continue }
        foreach ($file in 'facade.exe', 'facade-mcp.exe', 'VERSION', 'LICENSE.txt') {
            [IO.File]::Delete((Join-Path $folder.FullName $file))
        }
        $conpty = Get-Item -LiteralPath (Join-Path $folder.FullName 'conpty') -Force -ErrorAction SilentlyContinue
        if ($conpty -and $conpty.PSIsContainer -and -not ($conpty.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            foreach ($file in 'conpty.dll', 'OpenConsole.exe', 'LICENSE') {
                [IO.File]::Delete((Join-Path $conpty.FullName $file))
            }
            if (-not (Get-ChildItem -LiteralPath $conpty.FullName -Force)) { [IO.Directory]::Delete($conpty.FullName) }
        }
        if (-not (Get-ChildItem -LiteralPath $folder.FullName -Force)) { [IO.Directory]::Delete($folder.FullName) }
    }
    foreach ($folder in $Legacy.Versions, $Legacy.Root) {
        if (-not (Get-ChildItem -LiteralPath $folder -Force)) { [IO.Directory]::Delete($folder) }
    }
}

function Set-FacadePath {
    param([string] $Directory, [string] $OldDirectory)

    function Updated-Path([string] $Value) {
        $entries = @(if ($Value) {
            $Value -split ';' | Where-Object {
                $expanded = [Environment]::ExpandEnvironmentVariables($_)
                $expanded -ne $Directory -and (-not $OldDirectory -or $expanded -ne $OldDirectory)
            }
        })
        return (@($Directory) + $entries) -join ';'
    }

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $userPath = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $updated = Updated-Path $userPath
        if ($updated -cne $userPath) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
            $key.SetValue('Path', $updated, $kind)
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
    $env:Path = Updated-Path $env:Path
}

function Update-StandalonePath {
    param([string] $Directory)

    $legacy = Get-LegacyInstall
    Set-FacadePath $Directory $legacy.Bin
    if ($legacy.Versions) {
        try {
            Remove-LegacyInstall $legacy
        } catch [IO.IOException], [UnauthorizedAccessException] {
            Write-Warning "Could not remove all files from the old Facade installation. Close any running Shell from that installation. $($_.Exception.Message)"
        }
    }
}

$previousHome = $env:FACADE_HOME
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
            if (-not (Get-Download "$releases/latest/download/facade-framework-version.txt" $versionFile) -and
                -not (Get-Download "$mirror/facade-framework-version.txt" $versionFile)) {
                Write-DownloadFailure
                throw 'Could not download the stable Facade version from GitHub or facadecode.com.'
            }
            $latestBuild = Read-Build $versionFile 'The stable release did not provide a valid BUILD.'
            $Version = ($latestBuild -split '\+', 2)[0]
        }
        if (-not (Get-ReleasePackage "$releases/download/extension%2F$Version") -and
            -not (Get-ReleasePackage "$mirror/releases/$Version")) {
            Write-DownloadFailure
            $message = "Could not download $asset and its checksums for Facade $Version from GitHub or facadecode.com."
            if ($ExpectedBuild -or $latestBuild) { $message += ' Supply the matching release archive with -Package.' }
            throw $message
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
    $build = Read-Build (Join-Path $stage 'VERSION') 'The package did not provide a valid BUILD.'
    $pin = if ($ExpectedBuild) { $ExpectedBuild } else { $latestBuild }
    if ($pin -and $build -cne $pin) {
        throw "Expected Facade build $pin, found $build in the package. Supply the matching release archive with -Package."
    }
    if ($Version -and ($build -split '\+', 2)[0] -cne $Version) { throw "Expected Facade $Version, found $build in the package." }
    foreach ($program in $programs) {
        if (-not [IO.File]::Exists((Join-Path $stage $program))) { throw "The package has no $program." }
    }
    $candidate = Join-Path $stage 'facade.exe'
    $reported = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or $reported -isnot [string] -or $reported -cne "facade $build") {
        throw "The packaged executable does not report Facade build $build. Supply the matching release archive with -Package."
    }

    $env:FACADE_HOME = $InstallRoot
    $launcher = Join-Path $bin 'facade.exe'
    $before = $null
    if ([IO.File]::Exists($launcher)) {
        $before = & $launcher --version
        if ($LASTEXITCODE -ne 0) { throw 'Could not read the home launcher BUILD.' }
    }
    $mode = if ($NoActivate) { '--install-only' } else { '--takeover' }
    & $candidate daemon $mode
    if ($LASTEXITCODE -ne 0) { throw "Could not select Facade $build (exit $LASTEXITCODE)." }
    $reported = & $launcher --version
    if ($LASTEXITCODE -ne 0 -or $reported -isnot [string] -or -not ($reported -cmatch "\Afacade ($buildPattern)\z")) {
        throw 'The home launcher did not report a valid Facade BUILD.'
    }
    $selected = $Matches[1]
    $upToDate = $reported -ceq $before -or $selected -cne $build

    if (-not $upToDate -and -not $NoPath -and $env:FACADE_UPGRADE_REPORT -ne '1') {
        Update-StandalonePath $bin
        Write-Output 'Open a new terminal if your shell has an older PATH.'
    }
} finally {
    $env:FACADE_HOME = $previousHome
    if ([IO.Directory]::Exists($work)) { [IO.Directory]::Delete($work, $true) }
}
if ($upToDate) {
    Write-Output "Facade $selected is already up to date in $bin."
} else {
    Write-Output "Installed Facade $selected in $bin."
}
