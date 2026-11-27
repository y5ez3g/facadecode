Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class FacadeBootstrapInput {
    const int StdInputHandle = -10, FileTypePipe = 3;
    const int BrokenPipe = 109, NoData = 232, PipeNotConnected = 233;

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int slot);
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool PeekNamedPipe(IntPtr handle, IntPtr buffer, uint size,
        IntPtr read, out uint available, IntPtr left);

    public static string ReadDecision() {
        IntPtr handle = GetStdHandle(StdInputHandle);
        if (GetFileType(handle) != FileTypePipe) return Console.ReadLine();
        var input = Console.OpenStandardInput();
        string line = "";
        for (;;) {
            uint available;
            IntPtr nil = IntPtr.Zero;
            if (!PeekNamedPipe(handle, nil, 0, nil, out available, nil)) {
                int code = Marshal.GetLastWin32Error();
                if (code == BrokenPipe || code == NoData || code == PipeNotConnected) break;
                throw new Win32Exception(code);
            }
            // A read on an empty OpenSSH pipe can stall input.
            if (available == 0) { Thread.Sleep(20); continue; }
            int next = input.ReadByte();
            if (next < 0) break;
            if (next == '\n') return line.TrimEnd('\r');
            if (line.Length == 8) return "";
            line += (char)next;
        }
        return line.Length == 0 ? null : line.TrimEnd('\r');
    }
}
'@
