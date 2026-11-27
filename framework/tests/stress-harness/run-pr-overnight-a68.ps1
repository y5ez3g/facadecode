param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{3,55}$')][string]$RunName,
    [ValidatePattern('^[0-9a-f]{8,40}$')][string]$FinalHead,
    [string]$SmokePlan,
    [switch]$ClaudeFirst,
    [switch]$NoTiming,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$evidence = "$root\evidence\a68-pr"
$runDir = "$root\evidence\a68-pr-overnight\$RunName"
$integration = $tree
$integrationRef = 'refs/heads/feature/148-delivery'
$baseline = 'af9bb4b8'
$kit = 'pr7'
$judge = '832a65ba1b41e3bbf82442886b4696eb76bc6cf8+pr-ce877da8bef2'
$harness = "$root\bin\stress-a68-$kit-harness"
$pairRunner = "$work\run-pr-pairs-a68.ps1"
$gridRunner = "$work\run-pr-a68.ps1"
$builder = "$work\prepare-pr-a68.ps1"
$psRunner = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$stopFile = "$runDir\stop-after-cell"

function Resolve-Commit([string]$Reference) {
    $commit = & git.exe -C $integration rev-parse --verify "$Reference^{commit}"
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "Cannot read $Reference" }
    return $commit
}

function Find-FreeAttempts {
    $used = [Collections.Generic.HashSet[int]]::new()
    foreach ($version in (Get-ChildItem -LiteralPath $evidence -Directory -ErrorAction SilentlyContinue | Where-Object Name -match '^[0-9a-f]{8}$')) {
        foreach ($folder in 'fake-full','real') {
            foreach ($trial in (Get-ChildItem -LiteralPath "$($version.FullName)\$folder" -Directory -ErrorAction SilentlyContinue)) {
                if ($trial.Name -match '-a([0-9]{3})$') { [void]$used.Add([int]$Matches[1]) }
            }
        }
    }
    foreach ($file in (Get-ChildItem -LiteralPath $evidence -Filter 'timing-pairs-*.json' -File -ErrorAction SilentlyContinue)) {
        if ($file.Name -match '-([0-9]{3})\.json$') { [void]$used.Add([int]$Matches[1]) }
    }
    foreach ($run in (Get-ChildItem -LiteralPath (Split-Path -Parent $runDir) -Directory -ErrorAction SilentlyContinue)) {
        $file = Join-Path $run.FullName 'attempts.json'
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $range = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($ordinal in $range.first..$range.last) { [void]$used.Add($ordinal) }
        }
    }
    $width = 61
    for ($first = 200; $first -le 1000-$width; $first++) {
        $last = $first+$width-1
        if (@($first..$last | Where-Object { $used.Contains($_) }).Count) { continue }
        return [ordered]@{
            first=$first
            last=$last
            timing=@{first=$first; last=$first+11}
            matrix=@{first=$first+12; last=$first+20}
            fast_queues=@{first=$first+21; last=$last}
        }
    }
    throw 'No unused pr7 attempt range remains in a200-a999'
}

function Reserve-Attempts {
    $mutex = [Threading.Mutex]::new($false, 'Local\Facade148-a68-attempts')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (!$held) { throw 'Timed out reserving pr7 evidence numbers' }
        $range = Find-FreeAttempts
        Write-Json "$runDir\attempts.json" $range
        return $range
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

$fullBaseline = Resolve-Commit $baseline
$initialCommit = if ($FinalHead) { Resolve-Commit $FinalHead } else { Resolve-Commit $integrationRef }
$initialHead = $initialCommit.Substring(0,8)
$smoke = $null
if ($SmokePlan) {
    $smoke = Get-Content -LiteralPath $SmokePlan -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$FinalHead -or $smoke.candidate -ne $initialCommit) { throw 'The smoke plan needs the exact final commit' }
}
if ($ClaudeFirst -and !$smoke) { throw 'Claude-first order needs a pinned smoke plan' }
$claudeCases = @('claude idle.','claude busy.')
$deferTiming = $NoTiming -or [bool]$smoke
if ($deferTiming -and !$FinalHead) { throw 'Pin the product with -FinalHead when deferring timing pairs' }
$grid = & $pairRunner -Head $initialHead -Kit $kit -ShowPlan | ConvertFrom-Json
$timing = & $pairRunner -Head $initialHead -Kit $kit -Selection timing -ShowPlan | ConvertFrom-Json
$fast = & $pairRunner -Head $initialHead -Kit $kit -Selection fast-queues -PairsPerScenario 10 -ShowPlan | ConvertFrom-Json
if ($grid.Count -ne 222 -or @($grid | Where-Object stage -eq 'fake').Count -ne 210 -or
    @($grid.name | Sort-Object -Unique).Count -ne 222 -or $timing.Count -ne 220 -or $fast.Count -ne 2) {
    throw 'The frozen pr7 workload does not have the expected cases'
}
$plan = [ordered]@{
    kit = $kit
    judge = $judge
    baseline = $fullBaseline
    integration_ref = $integrationRef
    integration_preview = $initialHead
    final_commit = if ($FinalHead) { $initialCommit } else { $null }
    quiet_cpu_limit = 60
    minimum_free_gib = 8
    first_claude_cases = if ($ClaudeFirst) { $claudeCases } else { @() }
    timing = @{opportunistic=[bool]($FinalHead -and !$deferTiming); deferred=$deferTiming; cases=@($timing)}
    matrix = @{cases=@($grid)}
    fast_queues = @{cases=@($fast)}
}
if ($PlanOnly) {
    $plan.available_attempts = Find-FreeAttempts
    ConvertTo-Json -InputObject $plan -Depth 7
    return
}

[void][IO.Directory]::CreateDirectory($runDir)
$claim = [IO.File]::Open("$runDir\worker.started",[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try {
    $text = [Text.Encoding]::UTF8.GetBytes("$PID $([DateTimeOffset]::Now.ToString('o'))")
    $claim.Write($text,0,$text.Length)
} finally { $claim.Dispose() }

$state = [ordered]@{
    run = $RunName
    pid = $PID
    started = [DateTimeOffset]::Now.ToString('o')
    kit = $kit
    judge = $judge
    baseline = $fullBaseline
    candidate = $null
    phase = 'initializing'
    updated = $null
    steps = [ordered]@{}
    remaining = $null
}
$head = $null
$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($name in (Get-ChildItem Env: | Where-Object Name -like 'FACADE*' | Select-Object -ExpandProperty Name)) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$env:FACADE_HOME = "$root\homes\stress-a68-overnight\$RunName\fallback"
$env:FACADE_A68_STOP_FILE = $stopFile
$env:FACADE_A68_MIN_FREE_GIB = '8'

function Write-Json([string]$Path, $Value) {
    $pending = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($pending, (ConvertTo-Json -InputObject $Value -Depth 9), $utf8)
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($pending,$Path,[NullString]::Value) }
    else { [IO.File]::Move($pending,$Path) }
}

function Set-Phase([string]$Phase, [string]$Detail) {
    $state.phase = $Phase
    $state.detail = $Detail
    $state.updated = [DateTimeOffset]::Now.ToString('o')
    Write-Json "$runDir\status.json" $state
    [IO.File]::AppendAllText("$runDir\progress.log","$($state.updated) $Phase $Detail" + [Environment]::NewLine,$utf8)
}

function Check-Pause {
    if ((Test-Path -LiteralPath $stopFile -PathType Leaf) -or
        (Test-Path -LiteralPath "$evidence\$baseline\pause-after-cell" -PathType Leaf) -or
        ($head -and (Test-Path -LiteralPath "$evidence\$head\pause-after-cell" -PathType Leaf))) {
        throw [OperationCanceledException]::new('Stopped at a cell boundary')
    }
}

function Wait-Quiet([string]$Reason) {
    $last = $null
    $nextStatus = [DateTimeOffset]::MinValue
    while ($true) {
        Check-Pause
        if (Test-Path -LiteralPath $lock) {
            $detail = "Waiting for perf.lock for $Reason. " + (Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue)
        } else {
            $samples = @()
            foreach ($sample in 1..3) {
                Start-Sleep -Seconds 5
                Check-Pause
                if (Test-Path -LiteralPath $lock) { break }
                $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
                if ($null -eq $cpu.PercentProcessorTime) { break }
                $samples += [double]$cpu.PercentProcessorTime
            }
            if ($samples.Count -eq 3 -and ($samples | Measure-Object -Maximum).Maximum -le 60 -and
                !(Test-Path -LiteralPath $lock)) {
                $state.quiet_samples = $samples
                Set-Phase 'quiet' "$Reason. Whole-machine CPU $($samples -join '/ ') percent"
                return
            }
            $detail = "Waiting for quiet CPU for $Reason. Whole-machine samples $($samples -join '/ ') percent"
        }
        if ($detail -ne $last -or [DateTimeOffset]::Now -ge $nextStatus) {
            Set-Phase 'waiting' $detail.Trim()
            $last = $detail
            $nextStatus = [DateTimeOffset]::Now.AddMinutes(1)
        }
        Start-Sleep -Seconds 10
    }
}

function Invoke-Step([string]$Label, [string]$Exe, [string[]]$Arguments) {
    Check-Pause
    $stdout = "$runDir\$Label.out.log"
    $stderr = "$runDir\$Label.err.log"
    $state.steps[$Label] = [ordered]@{started=[DateTimeOffset]::Now.ToString('o'); stdout=$stdout; stderr=$stderr}
    Set-Phase $Label 'Started'
    $quoted = $Arguments | ForEach-Object {
        if ($_ -match '"|\\$') { throw "Unsupported argument for $Label" }
        '"' + $_ + '"'
    }
    $launch = @{
        FilePath = $Exe
        ArgumentList = $quoted
        WorkingDirectory = $work
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        PassThru = $true
    }
    $child = Start-Process @launch
    $null = $child.Handle
    $state.steps[$Label].pid = $child.Id
    Write-Json "$runDir\status.json" $state
    $child.WaitForExit()
    $code = $child.ExitCode
    $state.steps[$Label].exit_code = $code
    $state.steps[$Label].ended = [DateTimeOffset]::Now.ToString('o')
    Set-Phase $Label "Exited $code"
    Check-Pause
    return $code
}

function Invoke-Runner([string]$Label, [string]$Script, [string[]]$Arguments) {
    if ($drive.AvailableFreeSpace -lt 8GB) {
        throw "Insufficient free space on the scratch drive to start $Label"
    }
    $code = Invoke-Step $Label $psRunner (@('-NoLogo','-NoProfile','-NonInteractive','-File',$Script) + $Arguments)
    if ($code -ne 0) { throw "$Label exited $code. See $runDir\$Label.err.log" }
    return $code
}

function Read-Pairs([int]$FirstAttempt) {
    $path = "$evidence\timing-pairs-$head-$FirstAttempt.json"
    if (Test-Path -LiteralPath $path) {
        $records = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $records
    }
}

function Record-Coverage {
    $report = Get-Content -LiteralPath "$runDir\report-$kit.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $matrixRows = @($report.datasets.$head.rows | Where-Object {
        $_.mode -eq 'full' -and $_.state -eq 'measured' -and $_.evidence -match '-a([0-9]{3})$' -and
            [int]$Matches[1] -ge $attempts.matrix.first -and [int]$Matches[1] -le $attempts.matrix.last
    })
    $timingStart = if ($FinalHead) { $attempts.matrix.first } else { $timingAttempt }
    $timingRecords = @(Read-Pairs $timingStart)
    $timingPairs = @($timingRecords | Where-Object {
        $_.comparable -and $_.baseline.harness -eq $judge -and $_.candidate.harness -eq $judge
    })
    $fastRecords = @(Read-Pairs $fastAttempt)
    $fastPairs = @($fastRecords | Where-Object {
        ($FinalHead -or $_.comparable) -and $_.baseline.harness -eq $judge -and $_.candidate.harness -eq $judge
    })
    $fastCounts = @($fast | ForEach-Object {
        $caseName = $_.name
        [pscustomobject]@{name=$caseName; required=$_.required_pairs; measured=@($fastPairs | Where-Object name -eq $caseName).Count}
    })
    $missing = [ordered]@{
        timing = @($timing.name | Where-Object { $_ -notin $timingPairs.name })
        matrix = @($grid.name | Where-Object { $_ -notin $matrixRows.name })
        fast_queues = @($fastCounts | Where-Object {$_.measured -lt $_.required})
    }
    $latest = if ($FinalHead) { $state.candidate } else { Resolve-Commit $integrationRef }
    $followup = if ($latest -ne $state.candidate) {
        @(& git.exe -C $integration log --format='%h %s' "$($state.candidate)..$latest")
    } else { @() }
    Write-Json "$runDir\coverage.json" ([ordered]@{
        candidate = $state.candidate
        latest_integration = $latest
        later_commits = @($followup | Where-Object { $_ })
        timing = @{opportunistic=[bool]($FinalHead -and !$deferTiming); deferred=$deferTiming; cases=$timing.Count; matched=$timing.Count-$missing.timing.Count; pairs="$evidence\timing-pairs-$head-$timingStart.json"}
        matrix = @{required=$grid.Count; measured=$grid.Count-$missing.matrix.Count; attempts=$attempts.matrix; evidence="$evidence\$head"; rows=$matrixRows}
        fast_queues = @{scenarios=$fastCounts; pairs="$evidence\timing-pairs-$head-$fastAttempt.json"}
        remaining = $missing
    })
    $state.remaining = $missing
}

try {
    Set-Phase 'initializing' 'Reserving evidence and checking the frozen judge'
    $attempts = Reserve-Attempts
    $plan.attempts = $attempts
    $state.attempts = $attempts
    $timingAttempt = $attempts.timing.first
    $matrixAttempt = 'a{0:D3}' -f $attempts.matrix.first
    $fastAttempt = $attempts.fast_queues.first
    Write-Json "$runDir\plan.json" $plan
    if (!$FinalHead) { Wait-Quiet 'baseline preparation' }
    [void](Invoke-Runner "build-$baseline" $builder @('-Head',$fullBaseline,'-Kit',$kit))
    if ((Get-Content -LiteralPath "$harness\STORM_HEAD" -Raw).Trim() -ne $judge) { throw 'Unexpected pr7 judge version' }
    $hashes = Get-Content -LiteralPath "$harness\HASHES.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $hashes.PSObject.Properties) {
        if ((Get-FileHash -LiteralPath "$harness\$($item.Name)").Hash -ne $item.Value) { throw "Frozen pr7 fixture changed: $($item.Name)" }
    }
    $node = (Get-Command node.exe -CommandType Application).Source
    foreach ($tool in 'cargo.exe','rustc.exe','tar.exe','claude.exe','codex.exe','agy.exe','muse.cmd','opencode.cmd','pi.cmd') {
        [void](Get-Command $tool -CommandType Application)
    }
    [void](Invoke-Runner "profiles-$baseline" $gridRunner @('-Head',$baseline,'-Kit',$kit,'-Stage','profiles'))

    do {
        if ($FinalHead) {
            $candidate = Resolve-Commit $FinalHead
        } else {
            Wait-Quiet 'candidate selection'
            $candidate = Resolve-Commit $integrationRef
        }
        $head = $candidate.Substring(0,8)
        if ($head -eq $baseline) { throw 'The candidate matches the baseline' }
        $state.preparing_candidate = $candidate
        if ((Invoke-Runner "build-$head" $builder @('-Head',$candidate,'-Kit',$kit)) -ne 0) { throw "Build failed for $candidate" }
        $profileArgs = @('-Head',$head,'-Kit',$kit,'-Stage','profiles')
        if ($ClaudeFirst) {
            [void](Invoke-Runner "profiles-$head-claude" $gridRunner ($profileArgs + @('-Only','claude')))
        } else {
            [void](Invoke-Runner "profiles-$head" $gridRunner $profileArgs)
        }
        if ($FinalHead) { break }
        Wait-Quiet 'the paired timing phase'
        $current = Resolve-Commit $integrationRef
    } while ($candidate -ne $current)

    $state.candidate = $candidate
    $state.frozen_at = [DateTimeOffset]::Now.ToString('o')
    $state.raw_evidence = @("$evidence\$baseline","$evidence\$head")
    foreach ($version in $baseline,$head) {
        $bin = "$root\bin\stress-a68-$kit-$version"
        $wanted = if ($version -eq $baseline) { $fullBaseline } else { $candidate }
        if ((Get-Content -LiteralPath "$bin\HEAD" -Raw).Trim() -ne $wanted) { throw "The kit for $version does not match its frozen commit" }
        Copy-Item -LiteralPath "$bin\HASHES.json" -Destination "$runDir\hashes-$version.json"
    }

    $common = @('-Head',$head,'-Kit',$kit,'-Unattended')
    $fastMode = 'timing'
    $reportArgs = @("$work\report-pr-a68.mjs",'--kit',$kit,'--out',$runDir)
    if ($FinalHead) {
        $fastMode = 'check-pairs'
        $reportArgs += '--baseline-history'
        $matrixArgs = $common + @('-Mode','matrix','-FirstAttempt',"$($attempts.matrix.first)",'-LastAttempt',"$($attempts.matrix.last)")
        if ($deferTiming) {
            $common += '-NoTiming'
            $matrixArgs += '-NoTiming'
        }
        if ($smoke) {
            Copy-Item -LiteralPath $SmokePlan -Destination "$runDir\smoke-plan.json"
            $representatives = "$runDir\smoke-first.json"
            $redCases = "$runDir\smoke-red.json"
            Write-Json $representatives @($smoke.representative)
            Write-Json $redCases @($smoke.remaining_red)
            if ($ClaudeFirst) {
                $claudePath = "$runDir\claude-first.json"
                Write-Json $claudePath $claudeCases
                [void](Invoke-Runner 'claude-first' $pairRunner ($matrixArgs + @('-CaseListFile',$claudePath)))
                [void](Invoke-Runner "profiles-$head" $gridRunner @('-Head',$head,'-Kit',$kit,'-Stage','profiles'))
            }
            [void](Invoke-Runner 'smoke-first' $pairRunner ($matrixArgs + @('-CaseListFile',$representatives)))
            [void](Invoke-Runner 'smoke-fast-queues' $pairRunner ($common + @('-Mode',$fastMode,'-Selection','fast-queues',
                '-FirstAttempt',"$fastAttempt",'-LastAttempt',"$($attempts.fast_queues.last)",'-PairsPerScenario',"$($smoke.fast_pairs_per_scenario)")))
            [void](Invoke-Runner 'smoke-regressions' $pairRunner ($matrixArgs + @('-CaseListFile',$redCases)))
        }
        [void](Invoke-Runner 'matrix' $pairRunner $matrixArgs)
    } else {
        [void](Invoke-Runner 'timing' $pairRunner ($common + @('-Selection','timing',
            '-FirstAttempt',"$timingAttempt",'-LastAttempt',"$($attempts.timing.last)")))
        Wait-Quiet 'the candidate matrix'
        $matrixArgs = @('-Head',$head,'-Kit',$kit,'-Attempt',$matrixAttempt,'-LastAttempt',"$($attempts.matrix.last)",'-Fresh')
        [void](Invoke-Runner 'matrix-fake' $gridRunner ($matrixArgs + @('-Stage','fake','-ContinueAfterCellError')))
        foreach ($case in ($grid | Where-Object stage -eq 'real')) {
            [void](Invoke-Runner "matrix-$($case.prefix)" $gridRunner ($matrixArgs + @('-Stage','real','-Only',$case.name)))
        }
    }

    [void](Invoke-Runner 'fast-queues' $pairRunner ($common + @('-Mode',$fastMode,'-Selection','fast-queues',
        '-FirstAttempt',"$fastAttempt",'-LastAttempt',"$($attempts.fast_queues.last)",'-PairsPerScenario','10')))
    if ((Invoke-Step 'report' $node ($reportArgs + @($baseline,$head))) -ne 0) {
        throw 'Could not summarize the preserved raw runs'
    }
    Record-Coverage
    if ((!$FinalHead -and $state.remaining.timing.Count) -or $state.remaining.matrix.Count -or $state.remaining.fast_queues.Count) {
        Set-Phase 'incomplete' 'Read coverage.json for unfinished cases and the retained evidence'
        exit 2
    }
    Set-Phase 'complete' 'Candidate matrix and both fast-input comparisons are recorded. See coverage.json for timing coverage.'
} catch [OperationCanceledException] {
    Set-Phase 'paused' $_.Exception.Message
} catch {
    Set-Phase 'failed' ($_.Exception.Message + ' ' + $_.ScriptStackTrace)
    exit 1
}
