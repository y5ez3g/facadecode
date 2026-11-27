param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8}$')][string]$Head,
    [Parameter(Mandatory)][string]$Plan,
    [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$outPath = [IO.Path]::GetFullPath($Out)
if (!$outPath.StartsWith("$root\evidence\",[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a directory in the isolated evidence root'
}
[void][IO.Directory]::CreateDirectory($outPath)
$smoke = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$smoke.candidate.StartsWith($Head)) { throw 'The targeted tests need the exact candidate' }
$framework = "$root\src\stress-a68\$Head\framework"
$isolatedTarget = "$root\target-a68-$Head"
$target = if (Test-Path -LiteralPath $isolatedTarget) { $isolatedTarget } else { "$root\target-heads" }
$sourceKit = "$root\bin\stress-a68-$Head"
if ((Get-Content -LiteralPath "$sourceKit\HEAD" -Raw).Trim() -ne $smoke.candidate) { throw 'The product archive has the wrong commit' }
$cargo = (Get-Command cargo.exe -CommandType Application).Source
$repo = $tree
$archiveRoot = Split-Path -Parent $framework
$namesSource = 'extension/src/base/names.ts'
if (!(Test-Path -LiteralPath "$archiveRoot\$namesSource" -PathType Leaf)) {
    $support = "$outPath\fixture-names.tar"
    & git.exe -C $repo archive --format=tar "--output=$support" $smoke.candidate -- $namesSource
    if ($LASTEXITCODE -ne 0) { throw 'The candidate fixture could not be archived' }
    & tar.exe -xf $support -C $archiveRoot
    if ($LASTEXITCODE -ne 0) { throw 'The candidate fixture could not be extracted' }
    $expected = (& git.exe -C $repo rev-parse "$($smoke.candidate):$namesSource").Trim()
    $actual = (& git.exe hash-object "$archiveRoot\$namesSource").Trim()
    if ($expected -ne $actual) { throw 'The targeted fixture differs from the candidate' }
}
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$env:CARGO_TARGET_DIR = $target
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS = 'true'
foreach ($name in (Get-ChildItem Env: | Where-Object Name -like 'FACADE*' | Select-Object -ExpandProperty Name)) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$compiled = @{}
$started = [DateTimeOffset]::Now.ToString('o')
$results = @()
$utf8 = [Text.UTF8Encoding]::new($false)

function Save-Results([string]$State) {
    $path = "$outPath\targeted.json"
    $pending = "$path.$PID.tmp"
    [IO.File]::WriteAllText($pending, (ConvertTo-Json -InputObject @{
        head=$smoke.candidate; pid=$PID; started=$started; updated=[DateTimeOffset]::Now.ToString('o')
        state=$State; results=@($results)
    } -Depth 6), $utf8)
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($pending,$path,[NullString]::Value) }
    else { [IO.File]::Move($pending,$path) }
}

function Run-Program([string]$Exe,[string[]]$Arguments,[string]$Directory,[string]$Label,[int]$TimeoutSeconds) {
    $quotes = $Arguments | ForEach-Object {
        if ($_ -match '"|\\$') { throw "Unsupported argument for $Label" }
        '"' + $_ + '"'
    }
    $launch = @{
        FilePath=$Exe; ArgumentList=$quotes; WorkingDirectory=$Directory; WindowStyle='Hidden'; PassThru=$true
        RedirectStandardOutput="$outPath\$Label.out.log"; RedirectStandardError="$outPath\$Label.err.log"
    }
    $proc = Start-Process @launch
    $null = $proc.Handle
    if (!$proc.WaitForExit($TimeoutSeconds * 1000)) {
        taskkill.exe /PID $proc.Id /T /F | Out-Null
        $proc.WaitForExit()
        return 124
    }
    return $proc.ExitCode
}

function Build-Test([string]$Crate,[string]$TargetName) {
    $key = "$Crate-$TargetName"
    if ($compiled.ContainsKey($key)) { return $compiled[$key] }
    $argsForCargo = @('test','--offline','--locked','--release','-j','2','-p',$Crate,'--no-run','--message-format=json')
    if ($TargetName -eq 'lib') { $argsForCargo += '--lib' }
    else { $argsForCargo += @('--test',$TargetName) }
    $code = Run-Program $cargo $argsForCargo $framework "build-$key" 1500
    $binary = $null
    if ($code -eq 0) {
        $matchName = if ($TargetName -eq 'lib') { $Crate.Replace('-','_') } else { $TargetName }
        $binary = Get-Content -LiteralPath "$outPath\build-$key.out.log" -Encoding UTF8 |
            Where-Object { $_.StartsWith('{') } | ForEach-Object { $_ | ConvertFrom-Json } |
            Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.target.name -eq $matchName -and $_.executable } |
            Select-Object -Last 1 -ExpandProperty executable
        if (!$binary -or !(Test-Path -LiteralPath $binary -PathType Leaf)) { $code = 125 }
    }
    $compiled[$key] = [pscustomobject]@{code=$code; binary=$binary; log="$outPath\build-$key.out.log"}
    return $compiled[$key]
}

function Run-IsolatedTest([string]$Exe,[string]$Test,[string]$Number) {
    $fixture = "$root\homes\stress-a68-final-smoke-$Head-$PID-$Number"
    foreach ($dir in @($fixture,"$fixture\user","$fixture\roaming","$fixture\local","$fixture\tmp")) {
        [void][IO.Directory]::CreateDirectory($dir)
    }
    $settings = @{
        USERPROFILE="$fixture\user"; HOME="$fixture\user"; APPDATA="$fixture\roaming"; LOCALAPPDATA="$fixture\local"
        TEMP="$fixture\tmp"; TMP="$fixture\tmp"; TMPDIR="$fixture\tmp"
        FACADE_HOME="$fixture\fallback"; GIT_CONFIG_GLOBAL="$fixture\global-git"
    }
    $saved = @{}
    try {
        foreach ($name in $settings.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
            [Environment]::SetEnvironmentVariable($name,$settings[$name],'Process')
        }
        Run-Program $Exe @('--exact',$Test,'--test-threads=1','--nocapture') $fixture "fix-$Number" 300
    } finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')
        }
    }
}

Save-Results 'running'
foreach ($fix in $smoke.fix_coverage.PSObject.Properties) {
    if (!$fix.Value.test) { continue }
    $number = $fix.Name
    $crateName,$targetName,$testName = $fix.Value.test
    $build = Build-Test $crateName $targetName
    $caseStart = [DateTimeOffset]::Now.ToString('o')
    $before = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
    $code = if ($build.code -eq 0) { Run-IsolatedTest $build.binary $testName $number } else { $build.code }
    $after = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
    $elapsed = [double]$after.Timestamp_Sys100NS - [double]$before.Timestamp_Sys100NS
    $cpu = if ($elapsed -ge 10000000 -and $build.code -eq 0) {
        $sample = 100 * (1 - ([double]$after.PercentProcessorTime - [double]$before.PercentProcessorTime) / $elapsed)
        if ($sample -ge 0 -and $sample -le 100) { [Math]::Round($sample,2) }
    }
    $testLog = "$outPath\fix-$number.out.log"
    $ran = $build.code -eq 0 -and (Test-Path -LiteralPath $testLog) -and
        (Select-String -LiteralPath $testLog -SimpleMatch 'running 1 test' -Quiet)
    $result = if (!$ran) { 'could_not_run' } elseif ($code -eq 0) { 'passed' } else { 'failed' }
    $results += [pscustomobject]@{
        fix=$number; name=$testName; result=$result; exit_code=$code; started=$caseStart
        ended=[DateTimeOffset]::Now.ToString('o'); machine_cpu_percent=$cpu
        log=if ($build.code -eq 0) { $testLog } else { $build.log }
        build_code=$build.code
    }
    Save-Results 'running'
}
Save-Results 'complete'
