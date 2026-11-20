# Runs every test of the workspace in an empty temporary folder of its own, then lists any process the run left behind
# and anything a test wrote to the home folder. The Windows version of test-all.sh.
# Usage: scripts\test-all.ps1 [<log>]
# The tests run with USERPROFILE, HOME, APPDATA, LOCALAPPDATA and a fallback FACADE_HOME in the temporary folder.
# Each scenario sets its own FACADE_HOME. Writes to the fallback home are reported; cargo and rustup keep their own
# folders. The log, target\test-all.log by default, gets the commit, cargo's exit code, how many tests
# passed and failed, the first failures, what was written to the home folder, and the leftover check; <log>.full gets
# cargo's whole output. Exits 1 when a test failed, a test wrote to the home folder, or a process was left; the
# temporary folder then stays for a look.
param([string]$Log)
$ErrorActionPreference = 'Stop'
$core = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Log) { $Log = Join-Path $core 'target\test-all.log' }
# The run's folder, its TEMP and TMP, lies beside the checkout, in `.test-temp\` of the checkout's parent folder:
# outside every checkout, so that no Git call of a test finds the real repository above its folders, and beside the
# build, so that an antivirus exclusion of the folder holding the checkouts covers every copy of a Facade program a test
# makes.
$checkout = (git -C $core rev-parse --show-toplevel)
if (-not $checkout) { [Console]::Error.WriteLine("$core is not in a Git checkout"); exit 2 }
$tmp = Join-Path (Split-Path ([IO.Path]::GetFullPath($checkout))) ('.test-temp\facade-test-all.' + [IO.Path]::GetRandomFileName())
$home_ = Join-Path $tmp 'home'
$roaming = Join-Path $home_ 'AppData\Roaming'
$local = Join-Path $home_ 'AppData\Local'
New-Item -ItemType Directory -Force $roaming, $local | Out-Null
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

# The tests' environment, put back at the end for a caller who dot-sources this script.
$inherited = @(Get-ChildItem Env: | Where-Object Name -Match '^(FACADE_|CLAUDE_)' | Select-Object -ExpandProperty Name)
$names = @('FACADE_HOME', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
	'TMP', 'TEMP', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'CARGO_INCREMENTAL', 'CARGO_BUILD_JOBS', 'GIT_CONFIG_GLOBAL', 'PATH',
	'VSCMD_SKIP_SENDTELEMETRY', 'FACADE_TEST_BINARIES_BUILT') + $inherited
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$profile_ = $env:USERPROFILE
Push-Location $core
try {
	# rustup puts cargo here; a new shell may not have it on its PATH.
	if (-not $env:CARGO_HOME) { $env:CARGO_HOME = Join-Path $profile_ '.cargo' }
	if (-not $env:RUSTUP_HOME) { $env:RUSTUP_HOME = Join-Path $profile_ '.rustup' }
	$cargoBin = Join-Path $env:CARGO_HOME 'bin'
	if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
	$env:CARGO_INCREMENTAL = '0'
	$env:CARGO_BUILD_JOBS = '2'
	# The MSVC linker's telemetry helper would outlive the build, with the run's folder in its environment.
	$env:VSCMD_SKIP_SENDTELEMETRY = '1'
	$env:GIT_CONFIG_GLOBAL = Join-Path $tmp 'gitconfig'
	[IO.File]::WriteAllLines($env:GIT_CONFIG_GLOBAL, @('[user]', '    name = Facade QA', '    email = qa@example.invalid'))
	foreach ($name in $inherited) {
		[Environment]::SetEnvironmentVariable($name, $null, 'Process')
	}

	$head = git rev-parse --short HEAD
	$changed = @(git status --porcelain -- .).Count
	"== start $(Get-Date -Format 'yyyy-MM-dd HH:mm') $head changed-files=$changed" | Set-Content -Encoding utf8 $Log

	# Git for Windows mounts /tmp, for every Git Bash process of this user, from the temp folder of the first
	# one to start. One process of its own, started with the person's own environment and held for the run, keeps
	# that mount out of the tests' folders; it ends by its ID at the end.
	$holder = $null
	$exec = git --exec-path 2>$null
	if ($exec) {
		$sleep = Join-Path (Split-Path (Split-Path (Split-Path $exec))) 'usr\bin\sleep.exe'
		if (Test-Path $sleep) {
			$holder = Start-Process -FilePath $sleep -ArgumentList '86400' -WindowStyle Hidden -PassThru
		}
	}
	# Link the test executables and the programs test_binaries() uses with the person's environment. The MSVC
	# linker's telemetry helper may outlive cargo; it is part of the build, not the tests.
	& cmd.exe /d /c "cargo build -q -p facade -p facade-relay -p facade-scenarios --bin facade --bin facade-mcp --bin facade-fakecli > `"$Log.full`" 2>&1"
	$build = $LASTEXITCODE
	if ($build -eq 0) {
		& cmd.exe /d /c "cargo test -q --workspace --no-run >> `"$Log.full`" 2>&1"
		$build = $LASTEXITCODE
	}
	"build exit $build" | Add-Content -Encoding utf8 $Log
	if ($build -ne 0) {
		Get-Content $Log
		"kept $tmp"
		exit 1
	}
	# Workspace tests and test_binaries()' scoped build otherwise invalidate the fake CLI's cargo fingerprint.
	$env:FACADE_TEST_BINARIES_BUILT = '1'

	$env:USERPROFILE = $home_
	$env:HOME = $home_
	$env:APPDATA = $roaming
	$env:LOCALAPPDATA = $local
	$env:FACADE_HOME = Join-Path $home_ '.facade'
	$env:TMP = $tmp
	$env:TEMP = $tmp
	$env:TMPDIR = $tmp
	$began = [DateTime]::UtcNow.ToFileTimeUtc()
	# cmd.exe takes cargo's output and errors into one file as they come, as sh's 2>&1 does.
	& cmd.exe /d /c "cargo test -q --workspace --no-fail-fast >> `"$Log.full`" 2>&1"
	$tests = $LASTEXITCODE
	[Environment]::SetEnvironmentVariable('FACADE_HOME', $null, 'Process')
	foreach ($name in 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR') {
		[Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
	}

	$full = Get-Content "$Log.full"
	$passed = 0; $failed = 0
	foreach ($line in $full) {
		if ($line -match '^test result: \S+ (\d+) passed; (\d+) failed') {
			$passed += [int]$Matches[1]; $failed += [int]$Matches[2]
		}
	}
	$report = @("tests exit $tests", "passed $passed failed $failed")
	$report += @($full | Where-Object { $_ -match '^---- ' } | Select-Object -First 20)

	# What the tests wrote to the home folder, less the two empty folders made for APPDATA and LOCALAPPDATA.
	$made = @((Join-Path $home_ 'AppData'), $roaming, $local)
	$written = @(Get-ChildItem -Force -Recurse $home_ | Where-Object { $made -notcontains $_.FullName } |
			Select-Object -First 20 | ForEach-Object { '.' + $_.FullName.Substring($home_.Length) })
	if ($written.Count) {
		$report += 'written to the home folder:'
		$report += $written
	} else {
		$report += 'nothing written to the home folder'
	}

	$left = & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'leftovers.ps1') $tmp $core -Since $began 2>&1
	$leftCode = $LASTEXITCODE
	$report += @($left | Select-Object -First 20 | ForEach-Object { "$_" })
	$report += "== end $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
	$report | Add-Content -Encoding utf8 $Log
	Get-Content $Log

	if ($tests -eq 0 -and -not $written.Count -and $leftCode -eq 0) {
		Remove-Item -Recurse -Force -LiteralPath $tmp
		$code = 0
	} else {
		"kept $tmp"
		$code = 1
	}
} finally {
	if ($holder) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
	Pop-Location
	foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
exit $code
