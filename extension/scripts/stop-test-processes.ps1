param([Parameter(Mandatory = $true)][int]$RunnerPid)

$ErrorActionPreference = 'Stop'
$marker = $env:FACADE_IT_END
if ($marker -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})') {
    throw 'Expected the absolute path of a test profile or service.'
}
$marker = [IO.Path]::GetFullPath($marker)
if ($marker -eq [IO.Path]::GetPathRoot($marker)) {
    throw 'Expected the absolute path of a test profile or service.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FacadeTestProcesses {
    private const int QueryLimitedInformation = 0x1000;
    private const int Terminate = 0x0001;
    private const int Synchronize = 0x100000;
    private const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr handle, uint status);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr buffer, int size, out int returned);

    private static string CommandLine(IntPtr handle) {
        int size;
        NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out size);
        if (size < Marshal.SizeOf(typeof(UnicodeString)) || size > 65536 + 32) return null;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            int returned;
            if (NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, size, out returned) != 0) return null;
            var command = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
            long offset = command.Buffer.ToInt64() - buffer.ToInt64();
            if (command.Length % 2 != 0 || offset < 0 || offset > size - command.Length) return null;
            return Marshal.PtrToStringUni(command.Buffer, command.Length / 2);
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    public static void StopIfOwned(int pid, string marker) {
        IntPtr handle = OpenProcess(QueryLimitedInformation | Terminate | Synchronize, false, pid);
        if (handle == IntPtr.Zero) return;
        try {
            string command = CommandLine(handle);
            if (command == null || command.Replace('/', '\\').IndexOf(marker, StringComparison.OrdinalIgnoreCase) < 0) return;
            // Use the same process handle for the match and the stop, even if the PID is reused.
            if (!TerminateProcess(handle, 1)) {
                int error = Marshal.GetLastWin32Error();
                if (WaitForSingleObject(handle, 0) == 0) return;
                throw new Win32Exception(error);
            }
            if (WaitForSingleObject(handle, 2000) != 0) throw new TimeoutException("Test process " + pid + " did not exit.");
        } finally { CloseHandle(handle); }
    }
}
'@

foreach ($process in [Diagnostics.Process]::GetProcesses()) {
    try {
        if ($process.Id -ne $PID -and $process.Id -ne $RunnerPid) {
            [FacadeTestProcesses]::StopIfOwned($process.Id, $marker)
        }
    } finally { $process.Dispose() }
}
