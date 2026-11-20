using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

internal static class FacadeTestProcesses {
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

    public static int Main(string[] args) {
        try {
            int runnerPid;
            if (args.Length != 2 || !int.TryParse(args[1], out runnerPid) || runnerPid <= 0 ||
                !Regex.IsMatch(args[0], @"^(?:[A-Za-z]:[\\/]|[\\/]{2})")) {
                throw new ArgumentException("Expected an absolute test path and the test runner's PID.");
            }
            string marker = Path.GetFullPath(args[0]);
            if (marker == Path.GetPathRoot(marker)) throw new ArgumentException("Expected a non-root test path.");
            int ownPid;
            using (var self = Process.GetCurrentProcess()) ownPid = self.Id;
            foreach (var process in Process.GetProcesses()) {
                using (process) {
                    if (process.Id != ownPid && process.Id != runnerPid) StopIfOwned(process.Id, marker);
                }
            }
            return 0;
        } catch (Exception exception) {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

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

    private static void StopIfOwned(int pid, string marker) {
        IntPtr handle = OpenProcess(QueryLimitedInformation | Terminate | Synchronize, false, pid);
        if (handle == IntPtr.Zero) return;
        try {
            string command = CommandLine(handle);
            if (command == null || command.Replace('/', '\\').IndexOf(marker, StringComparison.OrdinalIgnoreCase) < 0) return;
            // Use the same process handle for the match and the stop, even if the PID is reused.
            bool terminated = TerminateProcess(handle, 1);
            int error = terminated ? 0 : Marshal.GetLastWin32Error();
            // The editor can already be shutting down when the sweep reaches it.
            if (WaitForSingleObject(handle, 2000) == 0) return;
            if (!terminated) throw new Win32Exception(error, "Could not stop test process " + pid + " (Windows error " + error + ").");
            throw new TimeoutException("Test process " + pid + " did not exit.");
        } finally { CloseHandle(handle); }
    }
}
