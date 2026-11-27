param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8}$')][string]$Head,
    [ValidateSet('pr5','pr6','pr7')][string]$Kit = 'pr7',
    [string[]]$Only,
    [string]$CaseListFile,
    [switch]$NoTiming,
    [ValidateRange(200,999)][int]$FirstAttempt = 701,
    [ValidateRange(200,999)][int]$LastAttempt = 999,
    [ValidateRange(1,20)][int]$PairsPerScenario = 1,
    [ValidateSet('all','timing','fast-queues')][string]$Selection = 'all',
    [ValidateSet('timing','matrix','check-pairs')][string]$Mode = 'timing',
    [switch]$Unattended,
    [switch]$ShowPlan
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$evidence = "$root\evidence\a68-pr"
$baseline = 'af9bb4b8'
$psRunner = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if ($Head -eq $baseline) { throw 'Supply the integration head assigned for the quiet window' }
$planPath = "$root\bin\stress-a68-$Kit-harness\fake-cases.json"
if (!(Test-Path -LiteralPath $planPath) -and $Kit -eq 'pr7') { $planPath = Join-Path $fixtures 'fake-cases.json' }
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
$cases = @( & {
    $index = 0
    foreach ($group in $plan.stages) {
        foreach ($name in $group.scenarios) {
            $index++
            [pscustomobject]@{name=$name; stage='fake'; folder='fake-full'; prefix=('c{0:D3}' -f $index)}
        }
    }
    foreach ($cli in 'claude','codex','agy','muse','opencode','pi') {
        foreach ($state in 'idle','busy') {
            [pscustomobject]@{name="$cli $state."; stage='real'; folder='real'; prefix="$cli-$state-50"}
        }
    }
})
$fastQueueNames = @('H1 fast attach queue','H1 fast raw queue')
if ($Selection -eq 'timing') { $cases = @($cases | Where-Object { $_.name -notin $fastQueueNames }) }
if ($Selection -eq 'fast-queues') { $cases = @($cases | Where-Object { $_.name -in $fastQueueNames }) }
if ($Only) {
    $cases = @($cases | Where-Object {$_.name -in $Only})
    if (Compare-Object @($Only | Sort-Object -Unique) @($cases.name | Sort-Object -Unique)) {
        throw 'Choose exact scenario names from the frozen plan'
    }
}
if ($CaseListFile) {
    $requested = Get-Content -LiteralPath $CaseListFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $byName = @{}
    foreach ($case in $cases) { $byName[$case.name] = $case }
    $cases = @(foreach ($name in $requested) {
        if (!$byName.ContainsKey($name)) { throw "Unknown selected pr7 scenario: $name" }
        $byName[$name]
    })
}
if ($ShowPlan) {
    $dryPlan = @($cases | Select-Object *,@{Name='required_pairs';Expression={$PairsPerScenario}})
    ConvertTo-Json -InputObject $dryPlan -Depth 4
    return
}

$baseline,$Head | ForEach-Object {
    & $psRunner -NoProfile -File "$work\prepare-pr-a68.ps1" -Head $_ -Kit $Kit
    if ($LASTEXITCODE -ne 0) { throw "Could not freeze product $_" }
}
if (!$Unattended -and $cases.stage -contains 'real') {
    foreach ($version in $baseline,$Head) {
        & $psRunner -NoProfile -File "$work\run-pr-a68.ps1" -Head $version -Kit $Kit -Stage profiles
        if ($LASTEXITCODE -ne 0) { throw "Could not audit real-CLI startup for $version" }
    }
}

function Is-Paused {
    ($env:FACADE_A68_STOP_FILE -and (Test-Path -LiteralPath $env:FACADE_A68_STOP_FILE)) -or
        (Test-Path -LiteralPath "$evidence\$baseline\pause-after-cell") -or
        (Test-Path -LiteralPath "$evidence\$Head\pause-after-cell")
}

function Ambient-Cpu([DateTimeOffset]$LatestStart) {
    while ($true) {
        if (Is-Paused) { throw 'Pausing at the end of the current cell' }
        if ([DateTimeOffset]::UtcNow -ge $LatestStart) { throw 'The candidate can no longer start in the same quiet window' }
        if (Test-Path -LiteralPath $lock) { Start-Sleep -Seconds 5; continue }
        $samples = @(1..3 | ForEach-Object {
            Start-Sleep -Seconds 1
            $counter = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
            if ($null -eq $counter.PercentProcessorTime) { throw 'The whole-machine CPU counter is unavailable' }
            [double]$counter.PercentProcessorTime
        })
        $ambient = [Math]::Round(($samples | Measure-Object -Average).Average,2)
        if (!$Unattended -or $Mode -ne 'timing') { return $ambient }
        if ($ambient -le 60 -and !(Test-Path -LiteralPath $lock) -and [DateTimeOffset]::UtcNow -lt $LatestStart) {
            return $ambient
        }
        Start-Sleep -Seconds 10
    }
}

function Measure-Scenario($version, $case, $attempt, [DateTimeOffset]$LatestStart, [Nullable[double]]$Ambient = $null) {
    if ($null -eq $Ambient) { $Ambient = Ambient-Cpu $LatestStart }
    if ($Mode -eq 'timing' -and $Ambient -gt 60) { throw "The quiet window was interrupted ($ambient% CPU before $version $($case.name))" }
    $started = [DateTimeOffset]::UtcNow
    & $psRunner -NoProfile -File "$work\run-pr-a68.ps1" -Head $version -Kit $Kit -Stage $case.stage -Only $case.name -Fresh -Attempt $attempt -LastAttempt $LastAttempt | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Could not measure $version $($case.name)" }
    $dirs = Get-ChildItem -LiteralPath "$evidence\$version\$($case.folder)" -Directory -Filter "$($case.prefix)-a*" -ErrorAction SilentlyContinue
    foreach ($dir in $dirs | Sort-Object Name -Descending) {
        $runPath = Join-Path $dir.FullName 'run.json'
        $reportPath = Join-Path $dir.FullName 'report.json'
        if (!(Test-Path -LiteralPath $runPath) -or !(Test-Path -LiteralPath $reportPath)) { continue }
        $run = Get-Content -LiteralPath $runPath -Raw | ConvertFrom-Json
        if ($run.exit_code -notin @(0,1) -or [DateTimeOffset]::Parse($run.started) -lt $started) { continue }
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $trial = $report.storms[0]
        if ($trial.name -ne $case.name -or $trial.could_not_run) { continue }
        if ($Unattended -and $case.name -in $fastQueueNames) {
            if (!$trial.evidence -or !(Test-Path -LiteralPath (Join-Path $trial.evidence 'tapes\a1.tape') -PathType Leaf)) {
                throw "Missing first receiver tape for $version $($case.name) in $($dir.FullName)"
            }
        }
        $stats = $trial.stats
        $metric = @($stats.notes.traffic_machine_cpu_percent,$stats.notes.traffic_load.machine_cpu_percent,
            $stats.notes.machine_cpu_percent,$stats.machine_cpu_percent,$run.machine_cpu_percent) |
            Where-Object {$null -ne $_} | Select-Object -First 1
        if ($null -eq $metric) { throw "Missing machine CPU for $version $($case.name)" }
        $hogs = if ($stats.notes.traffic_load.hogs) { $stats.notes.traffic_load.hogs }
            elseif ($stats.daemon_generations) { 14 } else { 0 }
        return [pscustomobject]@{evidence=$dir.FullName.Substring($evidence.Length+1); started=$run.started;
            ended=$run.ended; ambient_cpu=$ambient; measured_cpu=$metric; controlled_hogs=$hogs;
            kit=$run.bin; harness=$report.storm_head}
    }
    throw "A fresh report is missing for $version $($case.name)"
}

$manifest = "$evidence\timing-pairs-$Head-$FirstAttempt.json"
$pairs = @()
if (Test-Path -LiteralPath $manifest) {
    $savedPairs = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $pairs = @($savedPairs)
}
function Save-Pairs {
    $pending = "$manifest.$PID.tmp"
    $content = ConvertTo-Json -InputObject @($pairs) -Depth 6
    [IO.File]::WriteAllText($pending, $content, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $manifest) { [IO.File]::Replace($pending,$manifest,[NullString]::Value) }
    else { [IO.File]::Move($pending,$manifest) }
}

function Pair-Qualifies($Pair) {
    switch ($Mode) {
        'matrix' { return $null -ne $Pair.candidate }
        'check-pairs' { return $null -ne $Pair.baseline -and $null -ne $Pair.candidate }
        default { return [bool]$Pair.comparable }
    }
}

$incomplete = @()
foreach ($case in $cases) {
    $ordinal = $FirstAttempt
    $matched = @($pairs | Where-Object { $_.name -eq $case.name -and (Pair-Qualifies $_) }).Count
    $unmatched = 0
    while ($matched -lt $PairsPerScenario -and (!$Unattended -or $unmatched -lt 3)) {
        if (Is-Paused) { throw 'Pausing at the end of the current cell' }
        if (!(Test-Path -LiteralPath "$root\bin\stress-a68-$Kit-$Head\facade.exe" -PathType Leaf)) {
            throw "The frozen executable for $Head is unavailable. Completed evidence is still on disk."
        }
        if ($env:FACADE_A68_MIN_FREE_GIB -and $drive.AvailableFreeSpace -lt ([int]$env:FACADE_A68_MIN_FREE_GIB * 1GB)) {
            throw 'Insufficient free space on the scratch drive to start another pr7 measurement'
        }
        do {
            if ($ordinal -gt $LastAttempt) { throw "No unoccupied attempt for $($case.name) in a$FirstAttempt-a$LastAttempt" }
            $attempt = 'a{0:D3}' -f $ordinal
            $ordinal++
            $occupied = Test-Path -LiteralPath "$evidence\$baseline\$($case.folder)\$($case.prefix)-$attempt"
            $occupied = $occupied -or (Test-Path -LiteralPath "$evidence\$Head\$($case.folder)\$($case.prefix)-$attempt")
        } while ($occupied)
        $pair = [pscustomobject]@{
            name=$case.name; attempt=$attempt; mode=$Mode; baseline=$null; candidate=$null
            comparable=$false; gap_seconds=$null; baseline_note=$null; error=$null
        }
        try {
            $ambient = Ambient-Cpu ([DateTimeOffset]::MaxValue)
            $tryBaseline = $Mode -ne 'matrix' -or (!$NoTiming -and $ambient -le 60 -and $case.name -notin $fastQueueNames)
            if ($tryBaseline) {
                try {
                    $pair.baseline = Measure-Scenario $baseline $case $attempt ([DateTimeOffset]::MaxValue) $ambient
                } catch {
                    if ($Mode -ne 'matrix' -or (Is-Paused)) { throw }
                    $pair.baseline_note = $_.Exception.Message
                }
            } elseif ($NoTiming) {
                $pair.baseline_note = 'Baseline timing deferred by the run plan'
            } elseif ($case.name -in $fastQueueNames) {
                $pair.baseline_note = 'The dedicated fast-input pairs cover the baseline'
            } else {
                $pair.baseline_note = "Background CPU $ambient percent before the candidate"
            }
            $latest = if ($Unattended -and $Mode -eq 'timing') {
                [DateTimeOffset]::Parse($pair.baseline.ended).AddSeconds(60)
            } else { [DateTimeOffset]::MaxValue }
            $candidateAmbient = if (!$tryBaseline) { [Nullable[double]]$ambient } else { $null }
            $pair.candidate = Measure-Scenario $Head $case $attempt $latest $candidateAmbient
        } catch {
            if (!$Unattended -or (Is-Paused)) { throw }
            $pair.error = $_.Exception.Message
        }

        if ($pair.baseline -and $pair.candidate) {
            $old = $pair.baseline
            $new = $pair.candidate
            $gap = ([DateTimeOffset]::Parse($new.started) - [DateTimeOffset]::Parse($old.ended)).TotalSeconds
            $sameHogs = $old.controlled_hogs -eq $new.controlled_hogs
            $sameCpu = if ($sameHogs -and $old.controlled_hogs -gt 0) {
                $old.measured_cpu -ge 95 -and $new.measured_cpu -ge 95
            } else {
                $old.measured_cpu -le 60 -and $new.measured_cpu -le 60
            }
            $pair.comparable = !$NoTiming -and $sameHogs -and $sameCpu -and $old.harness -eq $new.harness -and
                $gap -ge 0 -and $gap -le 60 -and $old.ambient_cpu -le 60 -and $new.ambient_cpu -le 60 -and
                [Math]::Abs($old.ambient_cpu - $new.ambient_cpu) -le 10
            $pair.gap_seconds = [Math]::Round($gap,3)
        }
        $pairs += $pair
        Save-Pairs
        if (Pair-Qualifies $pair) { $matched++ } else { $unmatched++ }
        Write-Output "$($case.name) $attempt completed=$matched/$PairsPerScenario comparable=$($pair.comparable) baseline_cpu=$($pair.baseline.measured_cpu)% candidate_cpu=$($pair.candidate.measured_cpu)% $($pair.baseline_note) $($pair.error)"
    }
    if ($matched -lt $PairsPerScenario) { $incomplete += $case.name }
}
if ($incomplete.Count) {
    Write-Output "Incomplete $Mode cases: $($incomplete -join ' | ')"
    exit 2
}
