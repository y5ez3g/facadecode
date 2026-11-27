param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8}$')][string]$Head,
    [ValidateSet('pr2','pr3','pr4','pr5','pr6','pr7')][string]$Kit = 'pr7',
    [ValidateSet('all','fake','profiles','real')][string]$Stage = 'all',
    [ValidatePattern('^a[0-9]{3}$')][string]$Attempt = 'a001',
    [ValidateRange(1,999)][int]$LastAttempt = 999,
    [switch]$Pilot,
    [switch]$Fresh,
    [switch]$ContinueAfterCellError,
    [string]$Only
)

$ErrorActionPreference = 'Stop'
$pauseMarker = $env:FACADE_A68_STOP_FILE
$minimumFreeGiB = $env:FACADE_A68_MIN_FREE_GIB
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$frozen = "$root\bin\stress-a68-$Kit-harness"
$bin = "stress-a68-$Kit-$Head"
$binaries = "$root\bin\$bin"
$out = "$root\evidence\a68-pr\$Head"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$clis = @('claude','codex','agy','muse','opencode','pi')
$stamp = (Get-Content -LiteralPath "$binaries\HEAD" -Raw).Trim()
$judgeStamp = (Get-Content -LiteralPath "$frozen\STORM_HEAD" -Raw).Trim()
if (!$stamp.StartsWith($Head)) { throw 'The frozen product does not match the requested head' }
$productHashes = Get-Content -LiteralPath "$binaries\HASHES.json" -Raw | ConvertFrom-Json
foreach ($file in 'facade.exe','facade-mcp.exe','facade-storm.exe','facade-fakecli.exe') {
    if ((Get-FileHash -LiteralPath "$binaries\$file").Hash -ne $productHashes.$file) {
        throw "Product kit hash changed for $file"
    }
}
$fixtureHashes = Get-Content -LiteralPath "$frozen\HASHES.json" -Raw | ConvertFrom-Json
foreach ($file in 'fake-cases.json','fake-model-h2-a68.mjs','question-result.mjs','pi-direct-a68.cmd','h2-pi.ts') {
    if ((Get-FileHash -LiteralPath "$frozen\$file").Hash -ne $fixtureHashes.$file) {
        throw "Fixture hash changed for $file"
    }
}
[void][IO.Directory]::CreateDirectory($out)
$matrix = Get-Content -LiteralPath "$frozen\fake-cases.json" -Raw | ConvertFrom-Json
if ([int]$Attempt.Substring(1) -gt $LastAttempt) { throw 'The requested attempt is outside its allocated range' }
$mode = if ($Pilot) { 'pilot' } else { 'full' }
$count = if ($Pilot) { 5 } else { 50 }
$pilotCases = @('N2 nobody','B1 paste in chunks, echo 200 ms','S1 10 starts with a first message','N5 50 to 1 busy cores')

function Wait-Slot {
        if (Test-Path -LiteralPath $lock) { Write-Output "Waiting for $(Get-Content -LiteralPath $lock -ErrorAction SilentlyContinue)" }
    while ($true) {
        if ((Test-Path -LiteralPath "$out\pause-after-cell" -PathType Leaf) -or
            ($pauseMarker -and (Test-Path -LiteralPath $pauseMarker -PathType Leaf))) {
            Write-Output "Paused at a cell boundary for $Head"
            exit 0
        }
        if (!(Test-Path -LiteralPath $lock)) {
            if ($minimumFreeGiB -and $drive.AvailableFreeSpace -lt ([int]$minimumFreeGiB * 1GB)) {
                throw 'Insufficient free space on the scratch drive to start another pr7 measurement'
            }
            break
        }
        Start-Sleep -Seconds 5
    }
}

function Get-SceneResult($folder, $name) {
    $report = "$folder\report.json"
    $run = "$folder\run.json"
    if (!(Test-Path -LiteralPath $report) -or !(Test-Path -LiteralPath $run)) { return }
    try {
        $ended = Get-Content -LiteralPath $run -Raw | ConvertFrom-Json
        $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
        if ($ended.exit_code -in @(0,1) -and $result.head -eq $stamp -and $result.storm_head -eq $judgeStamp -and
            $result.storms.Count -eq 1 -and $result.storms[0].name -eq $name -and !$result.storms[0].could_not_run) {
            $result.storms[0]
        }
    } catch {
        Write-Verbose "Cannot read completed evidence in $folder"
    }
}

function Has-RealResult($folder, $name, $state) {
    $stats = (Get-SceneResult $folder $name).stats
    if (!$stats) { return $false }
    $expectedState = if ($state -eq 'idle') { @('idle','just_done') } else { @('working') }
    $messages = @($stats.messages | Where-Object { $_.number -ne $stats.notes.fixture_startup_message -or $null -eq $_.number })
    $stats.notes.state.as_sent -in $expectedState -and $messages.Count -eq $count -and
        'unverified_session' -notin $messages.category
}

if ($Stage -in @('all','fake')) {
    $cases = @(
        $index = 0
        foreach ($group in $matrix.stages) {
            foreach ($name in $group.scenarios) {
                ++$index
                [PSCustomObject]@{ number = $index; name = $name; set = $group.args[-1]; group = $group.label }
            }
        }
    ) | Where-Object { (!$Pilot -or $_.name -in $pilotCases) -and (!$Only -or $_.name -eq $Only -or $_.group -eq $Only) }
    if (!$cases) { throw 'The selected fake scenarios do not exist in the frozen grid' }
    Remove-Item Env:FACADE_AGENT,Env:FACADE_STORM_MODEL -ErrorAction SilentlyContinue
    $env:FACADE_STORM_PR_METRICS = '1'
    foreach ($case in $cases) {
        $cell = "c{0:D3}" -f $case.number
        if ($case.group -in @('r0','n','busy')) { $env:FACADE_STORM_WATCH = '1' } else {
            Remove-Item Env:FACADE_STORM_WATCH -ErrorAction SilentlyContinue
        }
        $storm = @('--only',('=' + $case.name),$case.set)
        if ($Pilot -and $case.name -like 'N5 *') { $storm = @('--senders','5') + $storm }
        $release = if ($case.group -in @('z1','z2')) { 27 } else { 12 }
        $first = [int]$Attempt.Substring(1)
        $done = $false
        for ($i=$first; $i -lt $first+3 -and $i -le $LastAttempt; $i++) {
            $suffix = 'a{0:D3}' -f $i
            $relative = "a68-pr\$Head\fake-$mode\$cell-$suffix"
            $folder = "$root\evidence\$relative"
            if (Get-SceneResult $folder $case.name) { $done = $true; break }
            if (Test-Path -LiteralPath $folder) { continue }
            do {
                Wait-Slot
                try {
                    & "$work\run-locked-a68.ps1" -Bin $bin -Evidence $relative -StormArgs $storm -ReleaseInMinutes $release
                    break
                } catch {
                    if (!(Test-Path -LiteralPath $lock) -or (Test-Path -LiteralPath $folder)) {
                        if (!$ContinueAfterCellError) { throw }
                        Write-Output "$cell $suffix could not start: $($_.Exception.Message)"
                        break
                    }
                }
            } while ($true)
            if (Get-SceneResult $folder $case.name) { $done = $true; break }
        }
        if (!$done) { Write-Output "Could not collect $cell $($case.name) after three attempts" }
    }
}

if ($Stage -in @('all','profiles','real')) {
    $profileStage = if ($Kit -eq 'pr2') { 'profiles' } else { "profiles-$Kit" }
    $certificate = if ($Kit -eq 'pr2') { 'verified-cli-profiles.json' } else { "verified-cli-$Kit-profiles.json" }
    $cert = "$out\$certificate"
    $profiles = @()
    $missingProfiles = @()
    foreach ($cli in $clis) {
        $probeSelected = $Kit -eq 'pr2' -or !$Only -or $Only.StartsWith($cli + ' ') -or $Only -eq $cli
        $choice = $null
        foreach ($probe in 'a001','a002','a003') {
            $folder = "$out\$profileStage\$cli-$probe"
            if ($probeSelected -and !(Test-Path -LiteralPath $folder)) {
                do {
                    Wait-Slot
                    & $powershell -NoProfile -File "$work\run-003-trial-a68.ps1" -PrHead $Head -PrKit $Kit -Cli $cli -State idle -Attempt $probe -H2Profile
                    if ((Test-Path -LiteralPath $folder) -or !(Test-Path -LiteralPath $lock)) { break }
                } while ($true)
            }
            $proof = "$folder\h2-profile\profile.json"
            if (!(Test-Path -LiteralPath $proof)) { continue }
            $result = Get-Content -Encoding UTF8 -LiteralPath $proof -Raw | ConvertFrom-Json
            if ($result.profile.loopback_settings -and $result.profile.external_proxy -and $result.native.saved -and
                $result.trial -eq $result.loopback_receipt.trial -and $result.screen -match '(?im)\bok\b') {
                $choice = "$cli-$probe"
                break
            }
        }
        if ($choice) { $profiles += [PSCustomObject]@{cli=$cli; probe=$choice} }
        elseif ($probeSelected) { $missingProfiles += $cli }
    }
    @{launcher=$bin; head=$stamp; clis=@($profiles.cli); profiles=$profiles; checked_at=(Get-Date).ToString('o')} |
        ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $cert
    if ($missingProfiles.Count) { throw "No audited startup proof for $Head $($missingProfiles -join ', ')" }
}

if ($Stage -in @('all','real')) {
    foreach ($entry in $profiles) {
        $cli = $entry.cli
        foreach ($state in 'idle','busy') {
            $name = "$cli $state."
            if ($Only -and $Only -notin @($cli,$name)) { continue }
            if ($Kit -eq 'pr2' -and $name -eq 'muse idle.') {
                $arguments = @('-NoProfile','-File',$PSCommandPath,'-Head',$Head,'-Kit','pr4','-Stage','real','-Only',$name,'-Attempt',$Attempt,'-LastAttempt',"$LastAttempt")
                if ($Pilot) { $arguments += '-Pilot' }
                if ($Fresh) { $arguments += '-Fresh' }
                & $powershell @arguments
                if ($LASTEXITCODE -ne 0) { throw "Could not collect the $Head $name measurement" }
                continue
            }
            $prefix = "$cli-$state-$count"
            if (!$Fresh) {
                $record = Get-ChildItem -LiteralPath "$out\real" -Directory -Filter "$prefix-a*" -ErrorAction SilentlyContinue |
                    Where-Object { Has-RealResult $_.FullName $name $state } | Select-Object -First 1
                if ($record) { continue }
            }
            $first = [int]$Attempt.Substring(1)
            $done = $false
            $started = 0
            for ($i=$first; $i -le $LastAttempt -and $started -lt 3; $i++) {
                $suffix = 'a{0:D3}' -f $i
                $folder = "$out\real\$prefix-$suffix"
                if (Test-Path -LiteralPath $folder) { continue }
                ++$started
                do {
                    Wait-Slot
                    & $powershell -NoProfile -File "$work\run-003-trial-a68.ps1" -PrHead $Head -PrKit $Kit -PrSenders $count -Cli $cli -State $state -Attempt $suffix
                    if ((Test-Path -LiteralPath $folder) -or !(Test-Path -LiteralPath $lock)) { break }
                } while ($true)
                if (Has-RealResult $folder $name $state) { $done = $true; break }
                if (!(Test-Path -LiteralPath $folder)) { break }
            }
            if (!$done) { throw "Could not collect $Head $name after $started attempt(s)" }
        }
    }
}

exit 0
