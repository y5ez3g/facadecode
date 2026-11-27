param(
    [Parameter(Mandatory)][ValidateSet('claude','codex','agy','muse','opencode','pi')][string]$Cli,
    [Parameter(Mandatory)][ValidateSet('idle','busy','keys')][string]$State,
    [Parameter(Mandatory)][ValidatePattern('^a[0-9]{3}$')][string]$Attempt,
    [ValidateRange(1,8)][int]$Each = 7,
    [switch]$StartupHintBaseline,
    [ValidateSet('unstyled','styled')][string]$HintRecovery,
    [switch]$HintCorrectness,
    [switch]$H2Profile,
    [switch]$H2FileTrace,
    [switch]$H2Calibration,
    [ValidateRange(0,130)][int]$H2Trials = 0,
    [switch]$H2Stock,
    [switch]$H2NewClis,
    [switch]$H2ResetTrials,
    [switch]$AuditedE2,
    [ValidateRange(1,390)][int]$E2Samples = 350,
    [ValidatePattern('^[0-9a-f]{8}$')][string]$PrHead,
    [ValidateSet('pr2','pr3','pr4','pr5','pr6','pr7')][string]$PrKit = 'pr2',
    [ValidateSet(5,10,50)][int]$PrSenders = 50,
    [ValidateSet(0,4,8,12,16)][int]$PrHogs,
    [switch]$Pause001,
    [ValidateSet('v1','v2')][string]$PauseRevision = 'v1',
    [ValidatePattern('^v(?:[4-9]|[1-9][0-9]+)$')][string]$H2Revision='v10'
)

$ErrorActionPreference = 'Stop'
if ($PrSenders -eq 10 -and (!$PrHead -or $PrKit -ne 'pr7' -or $Cli -ne 'claude' -or $State -ne 'idle' -or $H2Profile)) {
    throw 'Ten senders are for the audited pr7 Claude idle probe'
}
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$fixtureDir = if ($PrHead) { "$root\bin\stress-a68-$PrKit-harness" } else { $fixtures }
$modelLogs = Join-Path $root 'model-logs'
[void][IO.Directory]::CreateDirectory($modelLogs)
$modelOutput = "$modelLogs\model-$PID.out"
$modelError = "$modelLogs\model-$PID.err"
$h2 = $H2Profile -or $H2Calibration -or $H2Trials -gt 0
$ownedFixture = $h2 -or $AuditedE2 -or $PrHead
$codexCurve = $PSBoundParameters.ContainsKey('PrHogs')
if ($Pause001 -and ($PrHead -ne '1905bd55' -or $PrKit -ne 'pr5' -or $State -ne 'idle' -or $codexCurve)) {
    throw 'Use the audited 1905bd55 paused-output fixture'
}
if ($codexCurve -and (!$PrHead -or $PrKit -notin @('pr6','pr7') -or $Cli -ne 'codex' -or $State -ne 'idle' -or $PrSenders -ne 50 -or $H2Profile)) {
    throw 'Controlled cores are for the audited Codex 50-to-1 curve'
}
Remove-Item -LiteralPath Env:FACADE_STORM_H1_CORES -ErrorAction SilentlyContinue
if ($codexCurve) { $env:FACADE_STORM_H1_CORES = "$PrHogs" }
if (($AuditedE2 -or $PrHead) -and ($H2Calibration -or $H2Trials -or $HintRecovery -or $StartupHintBaseline)) {
    throw 'Select one measurement fixture'
}
if ($PrHead -and ($AuditedE2 -or $State -eq 'keys')) { throw 'Select a PR idle or busy delivery case' }
if ($H2FileTrace -and !$H2Profile) { throw 'File tracing requires the profile probe' }
$smallH2 = $H2Profile -or $H2Calibration -or ($H2Trials -gt 0 -and $H2Trials -le 8)
if ($HintCorrectness -or $smallH2) {
    (Get-Process -Id $PID).PriorityClass = 'BelowNormal'
    $env:FACADE_STORM_HINT_QUICK = '1'
} elseif (Test-Path -LiteralPath $lock) {
    throw 'Another measurement owns perf.lock'
}
if ($State -eq 'busy' -and $Each -eq 8) { throw 'The working round also sends one startup prompt' }
$port = @(18150,18152) | Where-Object {
    !(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $_ -State Listen -ErrorAction SilentlyContinue)
} | Select-Object -First 1
if (!$port) { throw 'Both test loopback model ports are in use' }
$mockName = if ($ownedFixture) { 'fake-model-h2-a68.mjs' } elseif ($HintRecovery) { 'fake-model-003-a68.mjs' } else { 'fake-model4.mjs' }
$modelScript = Join-Path $fixtureDir $mockName
$model = $null
Remove-Item Env:FACADE_AGENT,Env:SAY,Env:FACADE_E2_STOP_FILE,Env:FACADE_E2_HOLD_EVERY_TURN,Env:FACADE_STORM_AUDITED_MODEL,Env:FACADE_STORM_PR_METRICS -ErrorAction SilentlyContinue
$env:FACADE_HOME = "$root\homes\stress-a68-e2-model\fallback"
$env:FACADE_STORM_MODEL = "http://127.0.0.1:$port/v1"
$keyTest = $State -eq 'keys'
$museWorkingProbe = $AuditedE2 -and $keyTest -and $Attempt -in @('a002','a003','a004')
$probe = $null
if ($keyTest -and $Cli -ne 'muse') { throw 'This key experiment requires Muse' }
$env:FACADE_STORM_E2 = if ($keyTest) { '0' } else { '1' }
$measure = if ($keyTest) { 'a68-003-e1' } else { 'a68-003-e2' }
$case = "$measure\$Cli-$State-$Attempt"
$bin = 'stress-a68-e2-365fca99'
$minutes = 12
if ($StartupHintBaseline) {
    $env:FACADE_STORM_E2 = '0'
    $case = "a68-017\af9bb4b8-$Attempt"
    $bin = 'stress-a68-a68-m493-af9bb4b8'
    $minutes = 6
}
if ($HintRecovery) {
    $env:FACADE_STORM_E2 = '0'
    $case = "a68-017\af9bb4b8-$HintRecovery-$Attempt"
    $bin = 'stress-a68-017-af9bb4b8'
    $minutes = 7
    if ($HintRecovery -eq 'styled') {
        Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
        $env:TERM = 'xterm-256color'
        $env:FORCE_COLOR = '1'
    } else {
        $env:NO_COLOR = '1'
        $env:TERM = 'dumb'
        Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue
    }
}
if ($ownedFixture) {
    Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
    $env:TERM = 'xterm-256color'
    $env:FORCE_COLOR = '1'
    if ($Cli -eq 'pi') { $env:FACADE_STORM_H2_PI = "$fixtureDir\h2-pi.ts" }
    $vendorProgram = @{claude='claude.exe';codex='codex.exe';agy='agy.exe';muse='muse.cmd';
        opencode='opencode.cmd';pi='pi.cmd'}[$Cli]
    $programDirs = foreach ($program in @($vendorProgram,'node.exe','git.exe')) {
        $install = Split-Path -Parent (Get-Command $program -CommandType Application).Source
        if ($install -match '\\\.codex\\tmp\\') { throw "Unexpected temporary program path for $program" }
        $install
    }
    if ($Cli -eq 'pi') {
        $launcherDir = Split-Path -Parent (Get-Command pi.cmd -CommandType Application).Source
        $piRuntime = Join-Path (Split-Path -Parent $launcherDir) 'install\releases\1.4.0\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
        if (!(Test-Path -LiteralPath $piRuntime -PathType Leaf)) { throw 'The audited Pi 1.4.0 runtime is unavailable' }
        $env:FACADE_STORM_H2_PI_RUNTIME = $piRuntime
        $env:FACADE_STORM_H2_PI_WRAPPER = "$fixtureDir\pi-direct-a68.cmd"
        $env:FACADE_STORM_H2_NODE = (Get-Command node.exe -CommandType Application).Source
    }
    if ($h2 -and !$AuditedE2 -and !$PrHead -and $Cli -eq 'agy' -and $H2Revision -in @('v11','v12','v13','v14','v15')) {
        $env:FACADE_STORM_H2_AGY_PLAN = '1'
        $env:FACADE_STORM_ASKS = '1'
    }
    $env:Path = (@("$env:SystemRoot\System32","$env:SystemRoot\System32\WindowsPowerShell\v1.0",$env:SystemRoot) + $programDirs |
        Select-Object -Unique) -join ';'
}
if ($h2) {
    if ($H2Calibration -and $H2Trials) { throw 'Select calibration or formal trials' }
    $env:FACADE_STORM_E2 = '0'
    $env:FACADE_STORM_H2_LOG = $modelOutput
    $env:FACADE_H2_CALIBRATE = if ($H2Calibration) { '1' } else { '0' }
    $case = if ($H2Calibration) { "a68-014-h2\$Cli-calibrate-$Attempt" } else { "a68-014-h2\$Cli-trials-$Attempt" }
    $bin = if ($H2Calibration -or $H2Stock) { 'stress-a68-h2-r2-2c115bbd' } else { 'stress-a68-h2-trace-2c115bbd' }
    if ($H2NewClis) { $bin = 'stress-a68-h2-trace-v3-2c115bbd' }
    if ($H2ResetTrials) { $bin = "stress-a68-h2-trace-$H2Revision-2c115bbd" }
    if ($H2Profile) {
        $case = "a68-cli-isolation\$Cli-$Attempt"
        $bin = "stress-a68-h2-trace-$H2Revision-2c115bbd"
    } else {
        $stage = if ($H2Calibration) { 'calibrate' } else { 'trials' }
        $case = "a68-014-h2\verified\$Cli-$stage-$Attempt"
        $bin = 'stress-a68-h2-trace-v10-2c115bbd'
        if ($Cli -eq 'agy' -and $H2Revision -eq 'v11') { $bin = 'stress-a68-h2-trace-v11-2c115bbd' }
        if ($H2Revision -in @('v12','v14','v15','v16') -or ($Cli -eq 'agy' -and $H2Revision -eq 'v13')) {
            $bin = "stress-a68-h2-trace-$H2Revision-2c115bbd"
        }
    }
    $minutes = 25
}
if ($AuditedE2) {
    $bin = 'stress-a68-e2-audited-v2-365fca99'
    $case = if ($H2Profile) { "a68-e2-isolation\$Cli-$Attempt" } else { "$measure\verified\$Cli-$State-$Attempt" }
    $env:FACADE_STORM_AUDITED_MODEL = '1'
    if (!$H2Profile) { Remove-Item Env:FACADE_STORM_H2_LOG -ErrorAction SilentlyContinue }
    if (!$H2Profile -and !$keyTest -and $Attempt -ne 'a001') {
        $previous = "$root\evidence\a68-003-e2\verified\$Cli-$State.json"
        if (Test-Path -LiteralPath $previous -PathType Leaf) {
            $row = (Get-Content -LiteralPath $previous -Raw -Encoding UTF8 | ConvertFrom-Json).summary[0]
            if ($row.measured -gt 0 -and $row.measured -lt 300 -and $row.attempted -ge $row.measured) {
                $remaining = [Math]::Ceiling((315 - $row.measured) * $row.attempted / $row.measured)
                $E2Samples = [int][Math]::Min($E2Samples, $remaining)
            }
        }
    }
    if ($museWorkingProbe) {
        $env:FACADE_E2_STOP_FILE = "$root\evidence\$case\working-probe-complete"
    } elseif (!$H2Profile -and $State -eq 'busy') {
        $env:FACADE_E2_STOP_FILE = "$root\evidence\$case\traffic-complete"
        if ($Cli -eq 'muse') {
            $env:FACADE_E2_HOLD_EVERY_TURN = '1'
            $E2Samples = [Math]::Min($E2Samples, 28)
        }
    }
    if (!$H2Profile -and $Cli -eq 'pi') {
        if ($State -eq 'busy') { $E2Samples = [Math]::Min($E2Samples, 24) }
        elseif ($Attempt -ne 'a001') { $E2Samples = [Math]::Min($E2Samples, 120) }
    }
    $minutes = 29
}
if ($PrHead) {
    $bin = "stress-a68-$PrKit-$PrHead"
    $profileStage = if ($PrKit -eq 'pr2') { 'profiles' } else { "profiles-$PrKit" }
    $case = if ($H2Profile) { "a68-pr\$PrHead\$profileStage\$Cli-$Attempt" } elseif ($codexCurve) {
        "a68-pr\$PrHead\codex-curve\h$PrHogs-$Attempt"
    } else {
        "a68-pr\$PrHead\real\$Cli-$State-$PrSenders-$Attempt"
    }
    $env:FACADE_STORM_E2 = '0'
    $env:FACADE_STORM_AUDITED_MODEL = '1'
    if (!$H2Profile) {
        Remove-Item Env:FACADE_STORM_H2_LOG -ErrorAction SilentlyContinue
        $env:FACADE_STORM_PR_METRICS = '1'
        if ($State -eq 'busy') { $env:FACADE_E2_STOP_FILE = "$root\evidence\$case\traffic-complete" }
    }
    $minutes = 20
}
if ($Pause001) {
    $bin = if ($PauseRevision -eq 'v2') { 'stress-a68-pause001-v2-1905bd55' } else { 'stress-a68-pause001-1905bd55' }
    $stage = if ($H2Profile) { 'profiles' } else { 'trials' }
    $pauseRoot = if ($PauseRevision -eq 'v2') { 'a68-001-pause\v2' } else { 'a68-001-pause' }
    $case = "$pauseRoot\$stage\$Cli-$Attempt"
    $minutes = 6
}
if ($ownedFixture) {
    $parser = "$fixtureDir\question-result.mjs"
    $fixture = @{
        model_sha256 = (Get-FileHash -LiteralPath $modelScript).Hash
        result_parser_sha256 = (Get-FileHash -LiteralPath $parser).Hash
        question_leads_ms = $env:FACADE_STORM_H2_LEADS
        question_delay_ms = $env:FACADE_H2_ASK_DELAY
        codex_injection = $env:FACADE_H2_CODEX_INJECT -eq '1'
        loopback_port = $port
    }
}
try {
    $model = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"' + $modelScript + '"'),$port) `
        -WorkingDirectory $work -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $modelOutput -RedirectStandardError $modelError
    $until = (Get-Date).AddSeconds(25)
    do {
        if ($model.HasExited -or (Get-Date) -ge $until) { throw 'The owned loopback model did not start' }
        $listening = if ($ownedFixture) {
            Select-String -LiteralPath $modelOutput -Pattern ('"port":' + $port + ',"pid":' + $model.Id + '}') -SimpleMatch -Quiet -ErrorAction SilentlyContinue
        } else {
            Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -OwningProcess $model.Id -ErrorAction SilentlyContinue
        }
        if ($listening) { break }
        Start-Sleep -Milliseconds 250
    } while ($true)
    $stormArgs = if ($H2Profile) {
        @('--only',"$Cli h2 profile.",'--size','120x30','real')
    } elseif ($H2Calibration) {
        @('--only',"$Cli h2 calibrate.",'--size','120x30','real')
    } elseif ($H2Trials) {
        @('--only',"$Cli h2 trials.",'--each',"$H2Trials",'--size','120x30','real')
    } elseif ($HintRecovery) {
        @('--only','claude startup hint.','--size','120x30','real')
    } elseif ($museWorkingProbe) {
        @('--only','muse busy.','--senders','1','--each','0','--size','120x30','real')
    } elseif ($keyTest) {
        @('--only','muse keys.','--each','50','--size','120x30','real')
    } elseif ($Pause001) {
        @('--only',"$Cli pause001.",'--size','120x30','real')
    } elseif ($PrHead) {
        @('--only',"$Cli $State.",'--senders',"$PrSenders",'--each','1','--size','120x30','real')
    } elseif ($AuditedE2) {
        @('--only',"$Cli $State cores.",'--senders','1','--each',"$E2Samples",'--size','120x30','real')
    } else {
        @('--only',"$Cli $State cores.",'--senders','50','--each',"$Each",'--size','120x30','real')
    }
    if ($museWorkingProbe) {
        $probeScript = Join-Path $fixtures 'muse-working-keys-a68.mjs'
        $probe = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"' + $probeScript + '"'),$case) `
            -WorkingDirectory $work -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput "$modelLogs\muse-keys-$PID.out" -RedirectStandardError "$modelLogs\muse-keys-$PID.err"
        $null = $probe.Handle
    }
    if (($HintCorrectness -or $smallH2) -and !$Pause001) {
        & "$work\run-a68.ps1" -Bin $bin -Evidence $case -StormArgs $stormArgs -ProfileFileTrace:$H2FileTrace
    } else {
        & "$work\run-locked-a68.ps1" -Bin $bin -Evidence $case -StormArgs $stormArgs -ReleaseInMinutes $minutes
    }
    $code = $LASTEXITCODE
} finally {
    if ($null -ne $probe) {
        if (!$probe.WaitForExit(2000)) { $probe.Kill(); $probe.WaitForExit() }
        if (Test-Path -LiteralPath "$root\evidence\$case") {
            Copy-Item -LiteralPath "$modelLogs\muse-keys-$PID.out","$modelLogs\muse-keys-$PID.err" -Destination "$root\evidence\$case"
        }
    }
    if ($null -ne $model -and !$model.HasExited) {
        $model.Kill()
        $model.WaitForExit()
    }
    if (($HintRecovery -or $ownedFixture) -and (Test-Path -LiteralPath "$root\evidence\$case")) {
        Copy-Item -LiteralPath $modelOutput -Destination "$root\evidence\$case\model.log"
        if ($ownedFixture) {
            $fixture | ConvertTo-Json | Set-Content -LiteralPath "$root\evidence\$case\model-fixture.json" -Encoding UTF8
        }
    }
}
exit $code
