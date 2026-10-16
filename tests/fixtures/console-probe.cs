using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class ConsoleProbe {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static string B64(string text) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(text)); }
  static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length > 0 && args[0] == "--exit") { Console.Error.Write("fixture stderr"); return 23; }
    IntPtr window = GetConsoleWindow();
    bool child = args.Length > 0 && args[0] == "--child";
    string input = child ? "" : Console.ReadLine();
    Console.WriteLine("{\"console\":\"" + window.ToInt64() + "\",\"visible\":" +
      (IsWindowVisible(window) ? "true" : "false") + ",\"input\":\"" + B64(input ?? "") +
      "\",\"args\":\"" + B64(String.Join("\0", args)) + "\",\"cwd\":\"" + B64(Environment.CurrentDirectory) +
      "\",\"env\":\"" + B64(Environment.GetEnvironmentVariable("STUDIO_CONSOLE_TEST") ?? "") + "\"}");
    if (!child) {
      var process = Process.Start(new ProcessStartInfo {
        FileName = typeof(ConsoleProbe).Assembly.Location, Arguments = "--child",
        UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = false
      });
      Console.Write(process.StandardOutput.ReadToEnd());
      process.WaitForExit();
      return process.ExitCode;
    }
    return 0;
  }
}
