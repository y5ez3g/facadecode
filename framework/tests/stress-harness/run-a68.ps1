param(
    [Parameter(Mandatory)][string]$Bin,
    [Parameter(Mandatory)][string]$Evidence,
    [Parameter(Mandatory)][string[]]$StormArgs,
    [switch]$Trust,
    [switch]$ProfileFileTrace,
    [DateTimeOffset]$StopAt = [DateTimeOffset]::MaxValue
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
if ([DateTimeOffset]::Now -ge $StopAt) { throw 'The measurement lease has already expired' }
$pauseProbe = $false
if ($StormArgs -contains 'smoke') { throw 'Use the audited per-CLI profile probe' }
if (!$Trust -and $StormArgs -contains 'real') {
    $e2Bin = 'stress-a68-e2-audited-v2-365fca99'
    $pauseBins = @('stress-a68-pause001-1905bd55','stress-a68-pause001-v2-1905bd55')
    $prProduct = if ($Bin -match '^stress-a68-(pr2|pr3|pr4|pr5|pr6|pr7)-([0-9a-f]{8})$') {
        $prKit = $Matches[1]
        $Matches[2]
    }
    $profile = ($Bin -match '^stress-a68-h2-trace-v1[0123456]-2c115bbd$' -or $Bin -eq $e2Bin -or $Bin -in $pauseBins -or $prProduct) -and
        $StormArgs.Count -eq 5 -and $StormArgs[0] -eq '--only' -and
        $StormArgs[1] -match '^(claude|codex|agy|muse|opencode|pi) h2 profile\.$' -and
        $StormArgs[2] -eq '--size' -and $StormArgs[3] -eq '120x30'
    $verified = $false
    $verifiedFile = "$root\evidence\a68-cli-isolation\verified-h2-clis.json"
    if ($Bin -match '^stress-a68-h2-trace-v1[0123456]-2c115bbd$' -and $StormArgs[0] -eq '--only' -and
        $StormArgs[1] -match '^(claude|codex|agy|muse|opencode|pi) h2 (calibrate|trials)\.$' -and
        (Test-Path -LiteralPath $verifiedFile)) {
        $receiver = $Matches[1]
        $audit = Get-Content -LiteralPath $verifiedFile -Encoding UTF8 -Raw | ConvertFrom-Json
        $verified = $receiver -in $audit.clis -and (
            $audit.launcher -eq $Bin -or
            ($receiver -ne 'agy' -and $audit.recovery_launcher -eq $Bin) -or
            ($receiver -eq 'agy' -and $audit.agy_plan_launcher -eq $Bin) -or
            ($receiver -in @('codex','muse') -and $audit.panel_launcher -eq $Bin) -or
            $Bin -in @($audit.bounded_launcher, $audit.restart_launcher))
    }
    $auditedE2File = "$root\evidence\a68-e2-isolation\verified-e2-clis.json"
    if ($Bin -eq $e2Bin -and $env:FACADE_STORM_AUDITED_MODEL -eq '1' -and
        $StormArgs[0] -eq '--only' -and
        $StormArgs[1] -match '^(claude|codex|agy|muse|opencode|pi) (idle cores|busy cores|keys|busy)\.$' -and
        (Test-Path -LiteralPath $auditedE2File)) {
        $receiver = $Matches[1]
        $audit = Get-Content -LiteralPath $auditedE2File -Encoding UTF8 -Raw | ConvertFrom-Json
        $verified = $audit.launcher -eq $Bin -and $receiver -in $audit.clis -and
            ($StormArgs[1] -notlike '* keys.' -or $receiver -eq 'muse')
        if ($StormArgs[1] -like '* busy.') {
            $verified = $verified -and $receiver -eq 'muse' -and
                $Evidence -match '^a68-003-e1\\verified\\muse-keys-a00[2-4]$' -and
                ($StormArgs -join '|') -ceq '--only|muse busy.|--senders|1|--each|0|--size|120x30|real'
        }
    }
    if ($prProduct -and $env:FACADE_STORM_AUDITED_MODEL -eq '1' -and
        $StormArgs.Count -eq 9 -and $StormArgs[0] -eq '--only' -and
        $StormArgs[1] -match '^(claude|codex|agy|muse|opencode|pi) (idle|busy)\.$' -and
        $StormArgs[2] -eq '--senders' -and ($StormArgs[3] -in @('5','50') -or
            ($StormArgs[3] -eq '10' -and $prKit -eq 'pr7' -and $StormArgs[1] -eq 'claude idle.')) -and
        $StormArgs[4] -eq '--each' -and $StormArgs[5] -eq '1' -and
        $StormArgs[6] -eq '--size' -and $StormArgs[7] -eq '120x30') {
        $receiver = $Matches[1]
        $certificate = if ($prKit -eq 'pr2') { 'verified-cli-profiles.json' } else { "verified-cli-$prKit-profiles.json" }
        $auditPath = "$root\evidence\a68-pr\$prProduct\$certificate"
        if (Test-Path -LiteralPath $auditPath -PathType Leaf) {
            $audit = Get-Content -LiteralPath $auditPath -Encoding UTF8 -Raw | ConvertFrom-Json
            $verified = $audit.launcher -eq $Bin -and $receiver -in $audit.clis
        }
    }
    if ($Bin -in $pauseBins -and $env:FACADE_STORM_AUDITED_MODEL -eq '1' -and $StormArgs.Count -eq 5 -and
        $StormArgs[0] -eq '--only' -and $StormArgs[1] -match '^(claude|codex|agy|muse|opencode|pi) pause001\.$' -and
        $StormArgs[2] -eq '--size' -and $StormArgs[3] -eq '120x30') {
        $receiver = $Matches[1]
        $pauseEvidence = if ($Bin -like '*-v2-*') { 'a68-001-pause\v2' } else { 'a68-001-pause' }
        $certificate = "$root\evidence\$pauseEvidence\verified-cli-profiles.json"
        $requirePath = [regex]::Escape($pauseEvidence)
        $lease = Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue
        if ($Evidence -match "^$requirePath\\trials\\$receiver-a[0-9]{3}$" -and
            $lease -and $lease.StartsWith("a68 pid=$PID run=$Evidence ") -and (Test-Path -LiteralPath $certificate)) {
            $audit = Get-Content -LiteralPath $certificate -Raw -Encoding UTF8 | ConvertFrom-Json
            $verified = $audit.launcher -eq $Bin -and
                $audit.head -eq '1905bd55c99b583274de1068cbb8cf3b3e5b6478' -and $receiver -in $audit.clis
            $pauseProbe = $verified
        }
    }
    if (!$profile -and !$verified) {
        throw 'Real CLI stress remains paused until the matching isolation audit has passed'
    }
}
$bins = Join-Path $root 'bin'
$out = Join-Path (Join-Path $root 'evidence') $Evidence
$exeName = if ($Trust) { 'trust-tests.exe' } else { 'facade-storm.exe' }
$exe = Get-Item -LiteralPath (Join-Path $bins "$Bin\$exeName")
if (!$exe.FullName.StartsWith("$bins\", [StringComparison]::OrdinalIgnoreCase) -or
    !$out.StartsWith("$root\evidence\", [StringComparison]::OrdinalIgnoreCase) -or
    $Evidence -split '[/\\]' -contains '..') {
    throw 'The storm must use its own binaries and evidence directory'
}
$mem = Get-CimInstance Win32_PerfRawData_PerfOS_Memory
if ($mem.CommitLimit - $mem.CommittedBytes -lt 8GB) {
    throw 'Less than 8 GiB of system commit remains'
}
$homes = Join-Path $root 'homes'
$scratch = Join-Path $homes "stress-a68-$PID"
foreach ($name in (Get-ChildItem Env: | Select-Object -ExpandProperty Name)) {
    if ($name -match '^(FACADE|CLAUDE|CODEX|MUSE|ORCA|FAKECLI)' -and
        $name -notmatch '^FACADE_STORM_(PARTS|MODEL|FRAMES|TAILS|ENDINGS|WATCH|ASKS|RUNME|DELAYS|LINES|COST_SIZES|Z2_WAIT_60|E2|AUDITED_MODEL|PR_METRICS|HINT_QUICK|H2_LOG|H2_PI|H2_LEADS|H2_PI_RUNTIME|H2_PI_WRAPPER|H2_NODE|H2_AGY_PLAN|H1_CORES)$') {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
}
Remove-Item Env:FACADE_AGENT, Env:CARGO -ErrorAction SilentlyContinue
if ($Bin -match '^stress-a68-pr7-[0-9a-f]{8}$') {
    $productHead = (Get-Content -LiteralPath (Join-Path $bins "$Bin\HEAD") -Raw).Trim()
    git -C $tree grep -q -F 'fn needs_paste_space(' $productHead -- framework/crates/daemon/src/agent
    if ($LASTEXITCODE -notin @(0,1)) { throw 'Cannot identify the frozen product delivery format' }
    if ($LASTEXITCODE -eq 0) { $env:FACADE_STORM_DELIVERY_PASTE_SPACE = '1' }
}
if (!$Trust -and $StormArgs -contains 'real' -and
    $env:FACADE_STORM_MODEL -notmatch '^http://127\.0\.0\.1:(18150|18152)/v1$') {
    throw 'The real CLI matrix needs the owned loopback model'
}
$env:FACADE_HOME = Join-Path $scratch 'fallback'
$env:FACADE_STORM_ROOT = $root
if ($pauseProbe) { $env:FACADE_STORM_PAUSE001 = '1' }
if (!$env:FACADE_HOME.StartsWith("$homes\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'FACADE_HOME must be under the isolated homes directory'
}
[void][IO.Directory]::CreateDirectory($scratch)
[void][IO.Directory]::CreateDirectory($out)
$env:TEMP = $scratch
$env:TMP = $scratch
$env:TMPDIR = $scratch

function MachineCounter {
    Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
}

$arguments = if ($Trust) { $StormArgs } else { @('--out', $out) + $StormArgs }
$launchFile = $exe.FullName
if ($ProfileFileTrace) {
    if ($StormArgs[1] -notmatch '^(claude|codex|agy|muse|opencode|pi) h2 profile\.$') {
        throw 'The file trace accepts only an owned profile probe'
    }
    $traceTools = "$root\work\stress\cli-isolation-tools"
    $launchFile = "$traceTools\amd64\cdb.exe"
    $arguments = @('-o','-G','-sins','-y',$traceTools,'-logo',"$out\file-opens.trace",
        '-cf',"$traceTools\file-opens.txt",$exe.FullName) + $arguments
}
$quoted = $arguments | ForEach-Object {
    if ($_ -match '"|\\$') { throw "Unsupported argument quoting: $_" }
    '"' + $_ + '"'
}
$launch = @{
    FilePath = $launchFile
    ArgumentList = $quoted
    WorkingDirectory = $scratch
    WindowStyle = 'Hidden'
    PassThru = $true
    RedirectStandardOutput = Join-Path $out 'storm.log'
    RedirectStandardError = Join-Path $out 'storm.err'
}
$started = Get-Date
$before = MachineCounter
if ([DateTimeOffset]::Now -ge $StopAt) { throw 'The measurement lease expired during runner setup' }
$ownShell = Get-Process -Id $PID
$restorePriority = $ownShell.PriorityClass
try {
    if ($Trust) { $ownShell.PriorityClass = 'BelowNormal' }
    $process = Start-Process @launch
} finally {
    if ($Trust) { $ownShell.PriorityClass = $restorePriority }
}
$null = $process.Handle
Write-Output "$($started.ToString('HH:mm:ss')) pid=$($process.Id) $Evidence $($StormArgs -join ' ')"
$traceLimit = if ($ProfileFileTrace) { [DateTimeOffset]::Now.AddSeconds(195) } else { [DateTimeOffset]::MaxValue }
$waitUntil = if ($StopAt -lt $traceLimit) { $StopAt } else { $traceLimit }
$leaseDeadlineHit = $false
if ($waitUntil -eq [DateTimeOffset]::MaxValue) {
    $process.WaitForExit()
} else {
    $remaining = [int][Math]::Max(0,($waitUntil - [DateTimeOffset]::Now).TotalMilliseconds)
    if (!$process.WaitForExit($remaining)) {
        $leaseDeadlineHit = $StopAt -le $traceLimit
        if ($leaseDeadlineHit) {
            taskkill.exe /PID $process.Id /T /F | Out-Null
            Write-Output "Stopped the isolated measurement at its lease deadline: $Evidence"
        }
        if (!$process.HasExited) { $process.Kill() }
        $process.WaitForExit()
    }
}
$code = if ($leaseDeadlineHit) { 124 } else { $process.ExitCode }
$after = MachineCounter
$elapsed = [double]$after.Timestamp_Sys100NS - [double]$before.Timestamp_Sys100NS
$systemCpu = if ($elapsed -gt 0) {
    [Math]::Round(100 * (1 - ([double]$after.PercentProcessorTime - [double]$before.PercentProcessorTime) / $elapsed), 2)
}
@{
    started = $started.ToString('o')
    ended = (Get-Date).ToString('o')
    pid = $process.Id
    bin = $Bin
    args = $StormArgs
    profile_file_trace = [bool]$ProfileFileTrace
    exit_code = $code
    lease_deadline_hit = $leaseDeadlineHit
    delivery_paste_space = $env:FACADE_STORM_DELIVERY_PASTE_SPACE -eq '1'
    machine_cpu_percent = $systemCpu
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $out 'run.json') -Encoding UTF8
Write-Output "$(Get-Date -Format HH:mm:ss) exit=$code cpu=$systemCpu $Evidence"
exit $code
