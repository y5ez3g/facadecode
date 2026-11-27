param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8,40}$')][string]$Head,
    [ValidateSet('pr2','pr3','pr4','pr5','pr6','pr7')][string]$Kit = 'pr7'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'harness-paths.ps1')
$harness = "$root\bin\stress-a68-$Kit-harness"
$short = (git -C $tree rev-parse --short=8 --verify "$Head^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$commit = (git -C $tree rev-parse --verify "$Head^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$bin = "$root\bin\stress-a68-$Kit-$short"

function Hashes($folder, [string[]]$files) {
    $result = [ordered]@{}
    foreach ($file in $files) { $result[$file] = (Get-FileHash -LiteralPath "$folder\$file").Hash }
    $result
}

$ownShell = Get-Process -Id $PID
$priority = $ownShell.PriorityClass
$ownShell.PriorityClass = 'BelowNormal'
try {
    if (!(Test-Path -LiteralPath "$harness\HASHES.json")) {
        if ($Kit -ne 'pr7') { throw 'This archive builds pr7. Earlier kits require their original frozen binaries.' }
        $judgeSource = 'a1f81164ca025e36cab28a0c84e7b0d85f67513e'
        git -C $tree diff --quiet $judgeSource -- framework/tests/src framework/crates framework/rules framework/Cargo.toml framework/Cargo.lock
        if ($LASTEXITCODE -ne 0) { throw 'Build pr7 from the archived harness and its original dependencies' }
        $env:CARGO_TARGET_DIR = "$root\target-harness"
        $env:CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS = 'true'
        $env:CARGO_INCREMENTAL = '0'
        Push-Location -LiteralPath "$tree\framework"
        try {
            cargo build --offline --locked --release -j 2 -p facade-scenarios --bin facade-storm --bin facade-fakecli
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally { Pop-Location }
        [void][IO.Directory]::CreateDirectory($harness)
        foreach ($file in 'facade-storm.exe','facade-fakecli.exe') {
            Copy-Item -LiteralPath "$env:CARGO_TARGET_DIR\release\$file" -Destination $harness
        }
        $inputs = 'STORM_HEAD','fake-cases.json','fake-model-h2-a68.mjs','question-result.mjs','h2-pi.ts','pi-direct-a68.cmd'
        foreach ($file in $inputs) {
            Copy-Item -LiteralPath "$fixtures\$file" -Destination $harness
        }
        $files = @('facade-storm.exe','facade-fakecli.exe') + $inputs
        Hashes $harness $files | ConvertTo-Json | Set-Content -LiteralPath "$harness\HASHES.json" -Encoding UTF8
    }
    $source = "$root\bin\stress-a68-$short"
    if (!(Test-Path -LiteralPath "$source\HEAD")) {
        $runner = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        & $runner -NoProfile -File "$work\build-a68.ps1" -Head $commit
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    $stamp = (Get-Content -Raw -LiteralPath "$source\HEAD").Trim()
    if ($stamp -notin @($short,$commit)) { throw "Unexpected product stamp $stamp" }
    if (!(Test-Path -LiteralPath "$bin\HASHES.json")) {
        [void][IO.Directory]::CreateDirectory($bin)
        foreach ($file in 'facade.exe','facade-mcp.exe','conpty') {
            Copy-Item -LiteralPath "$source\$file" -Destination $bin -Recurse
        }
        foreach ($file in 'facade-storm.exe','facade-fakecli.exe','STORM_HEAD') {
            Copy-Item -LiteralPath "$harness\$file" -Destination $bin
        }
        $commit | Set-Content -LiteralPath "$bin\HEAD" -Encoding Ascii
        Hashes $bin @('facade.exe','facade-mcp.exe','facade-storm.exe','facade-fakecli.exe') |
            ConvertTo-Json | Set-Content -LiteralPath "$bin\HASHES.json" -Encoding UTF8
    }
    $library = (Get-Content -Raw -LiteralPath "$harness\HASHES.json" | ConvertFrom-Json)
    $product = (Get-Content -Raw -LiteralPath "$bin\HASHES.json" | ConvertFrom-Json)
    foreach ($file in 'facade.exe','facade-mcp.exe','facade-storm.exe','facade-fakecli.exe') {
        if (($library.$file -and $library.$file -ne $product.$file) -or
            (Get-FileHash -LiteralPath "$bin\$file").Hash -ne $product.$file) {
            throw "The frozen harness for $short differs on $file"
        }
    }
    Write-Output "$commit $bin"
} finally {
    $ownShell.PriorityClass = $priority
}
