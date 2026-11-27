$work = $PSScriptRoot
$tree = [IO.Path]::GetFullPath((Join-Path $work '..\..\..'))
$fixtures = Join-Path $work 'fixtures'
if (!$env:STRESS_HARNESS_ROOT) {
    $env:STRESS_HARNESS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'facade-148-stress'
}
$root = [IO.Path]::GetFullPath($env:STRESS_HARNESS_ROOT).TrimEnd('\', '/')
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root + '\'))
$env:STRESS_HARNESS_ROOT = $root
$lock = if ($env:STRESS_HARNESS_LOCK) { [IO.Path]::GetFullPath($env:STRESS_HARNESS_LOCK) }
    else { Join-Path $root 'perf.lock' }
