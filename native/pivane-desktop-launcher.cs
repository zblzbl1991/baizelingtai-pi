using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class DesktopLauncher
{
    private const string Product = "白泽灵台";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (args.Length > 0)
            {
                if (args[0] != "--create-shortcut" || args.Length > 2)
                    throw new ArgumentException("Usage: 白泽灵台.exe [--create-shortcut [directory]]");
                CreateShortcut(root, args.Length == 2 ? args[1] : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
                return 0;
            }
            string script = Path.Combine(root, "scripts", "desktop-tray.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("找不到托盘程序，请保留完整的白泽灵台目录。", script);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo(powershell);
            start.Arguments = "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"";
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("无法启动白泽灵台托盘。");
            }
            // The tray owns the managed service and reports actual readiness/errors.
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Product, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Set(object shortcut, string property, object value)
    {
        shortcut.GetType().InvokeMember(property, BindingFlags.SetProperty, null, shortcut, new object[] { value });
    }

    private static void CreateShortcut(string root, string directory)
    {
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("快捷方式目录不存在。");
        string filename = Path.Combine(Path.GetFullPath(directory), Product + ".lnk");
        if (File.Exists(filename)) throw new IOException("快捷方式已经存在，未覆盖：" + filename);
        object shell = null;
        object shortcut = null;
        try
        {
            // Windows Shell COM creates a native .lnk; no VBScript is executed.
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { filename });
            Set(shortcut, "TargetPath", Assembly.GetExecutingAssembly().Location);
            Set(shortcut, "WorkingDirectory", root);
            Set(shortcut, "IconLocation", Assembly.GetExecutingAssembly().Location + ",0");
            Set(shortcut, "Description", "启动白泽灵台并打开工作台");
            shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, new object[0]);
        }
        finally
        {
            if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
            if (shell != null) Marshal.FinalReleaseComObject(shell);
        }
    }
}
