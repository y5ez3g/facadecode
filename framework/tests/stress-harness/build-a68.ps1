param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8,40}$')][string]$Head,
    [switch]$Trust,
    [switch]$TrustOnly,
    [switch]$ZeroSettle
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$worktree = $tree

$mem = Get-CimInstance Win32_PerfRawData_PerfOS_Memory
if ($mem.CommitLimit - $mem.CommittedBytes -lt 8GB) { throw 'Less than 8 GiB of system commit remains' }
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$gitHead = git -C $worktree rev-parse --verify "$Head^{commit}"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$short = $gitHead.Substring(0, 8)
if ($ZeroSettle -and $short -ne '08c718f8') {
    throw 'Use the identified 001 revision whose delivery paste already schedules no pause'
}
$variant = if ($ZeroSettle) { "$short-p1-zero" } else { $short }
$source = Join-Path $root "src\stress-a68\$variant"
$bin = Join-Path $root "bin\stress-a68-$variant"
[void][IO.Directory]::CreateDirectory($source)
[void][IO.Directory]::CreateDirectory($bin)
$manifest = Join-Path $source 'framework\Cargo.toml'
if (!(Test-Path -LiteralPath $manifest)) {
    $archive = Join-Path $source 'source.tar'
    $inputs = @('framework','docs/framework')
    git -C $worktree cat-file -e "${gitHead}:extension/src/base/names.ts" 2>$null
    if ($LASTEXITCODE -eq 0) { $inputs += 'extension/src/base/names.ts' }
    git -C $worktree archive --format=tar "--output=$archive" $gitHead -- $inputs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    tar -xf $archive -C $source --exclude README.md
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$env:FACADE_HOME = Join-Path $root 'homes\stress-a68-build\fallback'
Remove-Item Env:FACADE_AGENT -ErrorAction SilentlyContinue
$env:TEMP = Split-Path -Parent $env:FACADE_HOME
$env:TMP = $env:TEMP
[void][IO.Directory]::CreateDirectory($env:TEMP)
if ($ZeroSettle) {
    $framework = Split-Path -Parent $manifest
    foreach ($cli in @('fake','claude','codex','opencode','pi')) {
        $rule = Join-Path $framework "rules\$cli.json"
        $content = Get-Content -LiteralPath $rule -Raw
        if ($content -notmatch '"enter_ms"\s*:\s*(80|0)\b') { throw "Unexpected settle rule: $cli" }
        $content = $content -replace '("enter_ms"\s*:\s*)80\b', '10'
        [IO.File]::WriteAllText($rule, $content)
    }
    Set-Content -LiteralPath (Join-Path $bin 'EXPERIMENT') -Encoding ASCII -Value (
        'Zero enter_ms for fake, Claude, Codex, OpenCode, Pi. Delivery PASTE_DELAY is zero in this product revision.'
    )
}
$targetPath = if ($env:FACADE_A68_BUILD_TARGET) { [IO.Path]::GetFullPath($env:FACADE_A68_BUILD_TARGET) }
    else { Join-Path $root "target-product-$variant" }
if (!$targetPath.StartsWith("$root\target-",[StringComparison]::OrdinalIgnoreCase)) {
    throw 'The build target must be under the isolated build root'
}
$env:CARGO_TARGET_DIR = $targetPath
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS = 'true'
Set-Location -LiteralPath (Split-Path -Parent $manifest)
if (!$TrustOnly) {
    cargo build --offline --locked --release -j 2 -p facade -p facade-relay --bins
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $release = Join-Path $env:CARGO_TARGET_DIR 'release'
    foreach ($name in @('facade.exe','facade-mcp.exe','conpty')) {
        Copy-Item -LiteralPath (Join-Path $release $name) -Destination $bin -Recurse -Force
    }
    Set-Content -LiteralPath (Join-Path $bin 'HEAD') -Value $gitHead -Encoding ASCII
}
if ($Trust -or $TrustOnly) {
    $messages = cargo test --offline --locked --release -j 2 -p facade-daemon --lib --no-run --message-format=json
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $test = $messages | ForEach-Object { ConvertFrom-Json -InputObject $_ } |
        Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'facade_daemon' -and $_.profile.test -and $_.executable } |
        Select-Object -Last 1 -ExpandProperty executable
    if (!$test) { throw 'Could not locate the daemon test executable' }
    Copy-Item -LiteralPath $test -Destination (Join-Path $bin 'trust-tests.exe') -Force
}
Write-Output "$short $bin"
