# Lists the processes a test run left behind, and exits 1 if there are any. The Windows version of leftovers.sh.
# Usage: scripts\leftovers.ps1 <the run's temporary folder> [<framework folder>] [-Since <UTC file time>]
# Only processes created since the tests began are counted when -Since is given.
# - A process working inside the temporary folder, or whose environment names a Facade home or a home folder inside it
#   (FACADE_HOME, HOME, USERPROFILE), is the run's: every scenario home and project, and every unit test's folder, is
#   there.
# - A process working inside <framework folder> whose parent has ended outlived the test program that started it: unit
#   tests run in their crate's folder.
# Reads each process's working folder and environment from its process parameters, so it needs 64-bit PowerShell. It
# only reads; it ends nothing.
param([Parameter(Mandatory = $true)][string]$Tmp, [string]$Facade Code Framework, [long]$Since = 0)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { Write-Error 'leftovers.ps1 needs 64-bit PowerShell'; exit 2 }
if (-not (Test-Path -LiteralPath $Tmp -PathType Container)) { [Console]::Error.WriteLine("no folder $Tmp"); exit 2 }
if ($Facade Code Framework -and -not (Test-Path -LiteralPath $Facade Code Framework -PathType Container)) {
	[Console]::Error.WriteLine("no folder $Facade Code Framework"); exit 2
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FacadeLeftovers {
	public class Info {
		public int Pid; public int Parent; public long Created;
		public string Folder; public string[] Environment;
	}

	[StructLayout(LayoutKind.Sequential)]
	struct BasicInformation {
		public IntPtr ExitStatus, Peb, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
	}

	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
	[DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
	[DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetLongPathNameW(string shortPath, StringBuilder longPath, int size);
	[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref BasicInformation info, int size, out int returned);

	const int QueryLimited = 0x1000, VmRead = 0x0010;

	static byte[] Read(IntPtr process, long address, int size) {
		var buffer = new byte[size];
		IntPtr read;
		if (!ReadProcessMemory(process, new IntPtr(address), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
		return buffer;
	}

	// The creation time of process `pid`, or 0 where it has ended or cannot be opened.
	public static long Created(int pid) {
		IntPtr process = OpenProcess(QueryLimited, false, pid);
		if (process == IntPtr.Zero) return 0;
		try {
			long created, exited, kernel, user;
			return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : 0;
		} finally { CloseHandle(process); }
	}

	// The process's parent, creation time, working folder and environment, from its process parameters (x64 layout:
	// ProcessParameters at PEB+0x20; CurrentDirectory at +0x38, Environment at +0x80, EnvironmentSize at +0x3F0).
	public static Info Read(int pid) {
		IntPtr process = OpenProcess(QueryLimited | VmRead, false, pid);
		if (process == IntPtr.Zero) return null;
		try {
			var basic = new BasicInformation();
			int returned;
			if (NtQueryInformationProcess(process, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0) return null;
			var info = new Info { Pid = pid, Parent = (int)basic.InheritedFromUniqueProcessId.ToInt64() };
			long created, exited, kernel, user;
			if (GetProcessTimes(process, out created, out exited, out kernel, out user)) info.Created = created;
			byte[] peb = Read(process, basic.Peb.ToInt64() + 0x20, 8);
			if (peb == null) return info;
			long parameters = BitConverter.ToInt64(peb, 0);
			byte[] head = Read(process, parameters, 0x3F8);
			if (head == null) return info;
			int folderBytes = BitConverter.ToUInt16(head, 0x38);
			byte[] folder = Read(process, BitConverter.ToInt64(head, 0x40), folderBytes);
			if (folder != null) info.Folder = Encoding.Unicode.GetString(folder);
			long size = BitConverter.ToInt64(head, 0x3F0);
			if (size > 0 && size < (16 << 20)) {
				byte[] block = Read(process, BitConverter.ToInt64(head, 0x80), (int)size);
				if (block != null) info.Environment = Encoding.Unicode.GetString(block).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
			}
			return info;
		} finally { CloseHandle(process); }
	}

	public static string LongPath(string path) {
		var buffer = new StringBuilder(32768);
		return GetLongPathNameW(path, buffer, buffer.Capacity) > 0 ? buffer.ToString() : path;
	}
}
'@

# Each folder as given and in its long form (TEMP may name it in 8.3 form), without a trailing backslash.
function Forms([string]$path) {
	$full = [IO.Path]::GetFullPath($path).TrimEnd('\')
	@($full, [FacadeLeftovers]::LongPath($full).TrimEnd('\')) | Select-Object -Unique
}
function Within([string]$path, [string[]]$folders) {
	if (-not $path) { return $false }
	$path = $path.TrimEnd('\')
	foreach ($folder in $folders) {
		if ($path -ieq $folder -or $path.StartsWith("$folder\", [StringComparison]::OrdinalIgnoreCase)) { return $true }
	}
	$false
}

$tmpForms = @(Forms $Tmp)
$frameworkForms = if ($Facade Code Framework) { @(Forms $Facade Code Framework) } else { @() }
$homeVariables = 'FACADE_HOME=', 'HOME=', 'USERPROFILE='

$pids = New-Object System.Collections.Generic.List[int]
foreach ($process in [Diagnostics.Process]::GetProcesses()) {
	if ($process.Id -eq $PID -or $process.Id -le 4) { continue }
	if ($Since -and [FacadeLeftovers]::Created($process.Id) -lt $Since) { continue }
	$info = [FacadeLeftovers]::Read($process.Id)
	if (-not $info -or $info.Created -lt $Since) { continue }
	$ours = Within $info.Folder $tmpForms
	if (-not $ours -and $info.Environment) {
		foreach ($entry in $info.Environment) {
			foreach ($variable in $homeVariables) {
				if ($entry.StartsWith($variable, [StringComparison]::OrdinalIgnoreCase) -and
					(Within $entry.Substring($variable.Length) $tmpForms)) { $ours = $true }
			}
		}
	}
	if (-not $ours -and $frameworkForms.Count -and (Within $info.Folder $frameworkForms)) {
		# Windows gives an orphan no new parent: its parent has ended, or the ID now names a later process.
		$parent = [FacadeLeftovers]::Created($info.Parent)
		$ours = $parent -eq 0 -or $parent -gt $info.Created
	}
	if ($ours) { $pids.Add($info.Pid) }
}

if (-not $pids.Count) { 'no processes left'; exit 0 }
'processes left:'
$now = Get-Date
foreach ($id in $pids) {
	$row = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
	if (-not $row) { continue }
	$age = if ($row.CreationDate) { '{0:d\.hh\:mm\:ss}' -f ($now - $row.CreationDate) } else { '?' }
	$command = if ($row.CommandLine) { $row.CommandLine } else { $row.ExecutablePath }
	$line = '{0,7} {1,7} {2,12} {3}' -f $id, $row.ParentProcessId, $age, $command
	if ($line.Length -gt 200) { $line = $line.Substring(0, 200) }
	$line
}
exit 1
