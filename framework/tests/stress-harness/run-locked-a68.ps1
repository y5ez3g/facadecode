param(
    [Parameter(Mandatory)][string]$Bin,
    [Parameter(Mandatory)][string]$Evidence,
    [Parameter(Mandatory)][string[]]$StormArgs,
    [Parameter(Mandatory)][ValidateRange(1,30)][int]$ReleaseInMinutes
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$out = Join-Path "$root\evidence" $Evidence
if (Test-Path -LiteralPath $out) { throw "Evidence already exists at $out" }
$deadline = [DateTimeOffset]::Now.AddMinutes($ReleaseInMinutes)
$estimate = $deadline.ToString('yyyy-MM-dd HH:mm:ss zzz')
$owner = "a68 pid=$PID run=$Evidence expected_release=$estimate token=$([Guid]::NewGuid())"
$lease = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try {
    $record = [Text.Encoding]::UTF8.GetBytes($owner)
    $lease.Write($record, 0, $record.Length)
    $lease.Flush()
    Write-Output "Acquired perf.lock $owner"
    & "$work\run-a68.ps1" -Bin $Bin -Evidence $Evidence -StormArgs $StormArgs -StopAt ($deadline.AddSeconds(-15))
    $code = $LASTEXITCODE
} finally {
    $lease.Dispose()
    if ((Test-Path -LiteralPath $lock) -and [IO.File]::ReadAllText($lock) -eq $owner) {
        Remove-Item -LiteralPath $lock
        Write-Output "Released perf.lock at $([DateTimeOffset]::Now.ToString('o')) for $Evidence"
    }
}
exit $code
