using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// GUI subsystem: this launcher never owns a visible window. The console is created
// hidden for the CLI at creation time, so its ordinary descendants inherit it.
internal static class HiddenHost {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public uint cb;
    public string reserved, desktop, title;
    public uint x, y, width, height, columns, rows, fill, flags;
    public ushort show, reservedSize;
    public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
    ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  // Windows CRT argument escaping; never concatenate an unescaped shell command.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }

  static int Main(string[] args) {
    if (args.Length == 0) return 64;
    var startup = new StartupInfo();
    startup.cb = (uint)Marshal.SizeOf(startup);
    startup.flags = 0x00000001 | 0x00000100; // USESHOWWINDOW | USESTDHANDLES
    startup.show = 0; // SW_HIDE, applied before any console is shown
    startup.input = GetStdHandle(-10);
    startup.output = GetStdHandle(-11);
    startup.error = GetStdHandle(-12);
    foreach (IntPtr handle in new[] { startup.input, startup.output, startup.error }) {
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) SetHandleInformation(handle, 1, 1);
    }
    var command = new StringBuilder();
    foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
    ProcessInfo child;
    if (!CreateProcessW(args[0], command, IntPtr.Zero, IntPtr.Zero, true,
      0x00000010, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) {
      Console.Error.WriteLine("Cannot start CLI: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
      return 127;
    }
    CloseHandle(child.thread);
    WaitForSingleObject(child.process, 0xffffffff);
    uint exit;
    GetExitCodeProcess(child.process, out exit);
    CloseHandle(child.process);
    return unchecked((int)exit);
  }
}
