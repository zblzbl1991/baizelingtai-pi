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

// Read-only waiting entry owned by the existing tray process, never a controller.
public sealed class PivaneStartupHost : IDisposable
{
    private readonly System.Net.Sockets.TcpListener listener;
    private readonly System.Threading.SemaphoreSlim connections = new System.Threading.SemaphoreSlim(8, 8);
    private readonly System.Collections.Generic.Dictionary<string, byte[]> assets = new System.Collections.Generic.Dictionary<string, byte[]>();
    private readonly System.Collections.Generic.Dictionary<string, string> types = new System.Collections.Generic.Dictionary<string, string>();
    private readonly string instance;
    private readonly string authority;
    private volatile bool disposed;
    private byte[] status;
    public string Url { get; private set; }
    public PivaneStartupHost(string root, string instanceId) : this(root, instanceId, new int[0]) { }
    public PivaneStartupHost(string root, string instanceId, int[] reservedPorts)
    {
        Guid parsed;
        if (!Guid.TryParse(instanceId, out parsed)) throw new ArgumentException("Invalid tray instance.");
        instance = parsed.ToString();
        string[] routes = { "/", "/startup.css", "/startup.js", "/brand.png", "/brand-horizontal.svg", "/brand-horizontal-dark.svg" };
        string[] files = { "desktop-startup.html", "desktop-startup.css", "desktop-startup.js", "brand/logo-64.png", "brand/logo-horizontal.svg", "brand/logo-horizontal-dark.svg" };
        string[] contentTypes = { "text/html; charset=utf-8", "text/css; charset=utf-8", "text/javascript; charset=utf-8", "image/png", "image/svg+xml", "image/svg+xml" };
        for (int i = 0; i < routes.Length; i++)
        {
            string file = Path.Combine(root, "public", files[i]);
            FileInfo info = new FileInfo(file);
            if (!info.Exists || info.Length > 131072 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Invalid startup asset: " + files[i]);
            byte[] bytes = File.ReadAllBytes(file);
            if (i == 0)
            {
                string html = System.Text.Encoding.UTF8.GetString(bytes);
                bytes = System.Text.Encoding.UTF8.GetBytes(html.Replace("<head>", "<head>\n<meta name=\"startup-instance\" content=\"" + instance + "\">"));
            }
            assets.Add(routes[i], bytes); types.Add(routes[i], contentTypes[i]);
        }
        status = System.Text.Encoding.UTF8.GetBytes("{\"state\":\"starting\",\"instance\":\"" + instance + "\",\"generation\":\"\"}");
        // The service has a separate deterministic 40000-59999 allocation range.
        for (int attempt = 0; attempt < 64; attempt++)
        {
            System.Net.Sockets.TcpListener candidate = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            candidate.Start(8);
            int port = ((System.Net.IPEndPoint)candidate.LocalEndpoint).Port;
            if ((port >= 40000 && port < 60000) || Array.IndexOf(reservedPorts ?? new int[0], port) >= 0) { candidate.Stop(); continue; }
            listener = candidate; authority = "127.0.0.1:" + port; Url = "http://" + authority + "/"; break;
        }
        if (listener == null) throw new IOException("Unable to allocate waiting entry.");
        System.Threading.Thread thread = new System.Threading.Thread(Accept);
        thread.IsBackground = true; thread.Name = "pivane-startup"; thread.Start();
    }
    public void Update(string json)
    {
        if (disposed) return;
        if (json == null || System.Text.Encoding.UTF8.GetByteCount(json) > 16384) throw new ArgumentException("Startup status exceeds budget.");
        var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
        var value = serializer.Deserialize<System.Collections.Generic.Dictionary<string, object>>(json);
        if (!value.ContainsKey("instance") || (string)value["instance"] != instance) throw new ArgumentException("Wrong tray instance.");
        string state = value.ContainsKey("state") ? value["state"] as string : null;
        if (state != "starting" && state != "ready" && state != "error" && state != "stopped" && state != "stopping" && state != "unknown") throw new ArgumentException("Invalid startup state.");
        System.Threading.Interlocked.Exchange(ref status, System.Text.Encoding.UTF8.GetBytes(json));
    }
    private void Accept()
    {
        while (!disposed)
        {
            try
            {
                var client = listener.AcceptTcpClient();
                if (!connections.Wait(0)) { client.Close(); continue; }
                System.Threading.ThreadPool.QueueUserWorkItem(delegate { try { Serve(client); } catch { } finally { client.Close(); connections.Release(); } });
            }
            catch (System.Net.Sockets.SocketException) { if (!disposed) Dispose(); }
            catch (ObjectDisposedException) { break; }
        }
    }
    private void Serve(System.Net.Sockets.TcpClient client)
    {
        client.ReceiveTimeout = 3000; client.SendTimeout = 3000;
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        using (var stream = client.GetStream())
        {
            var header = new System.Text.StringBuilder();
            while (header.Length < 8192)
            {
                int remaining = 3000 - (int)deadline.ElapsedMilliseconds; if (remaining <= 0) return;
                stream.ReadTimeout = remaining;
                int c = stream.ReadByte(); if (c < 0) return;
                if (c > 127 || c == 0) { Respond(stream, 400, "text/plain", new byte[0], false); return; }
                header.Append((char)c);
                if (header.Length >= 4 && header.ToString(header.Length - 4, 4) == "\r\n\r\n") break;
            }
            if (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) { Respond(stream, 431, "text/plain", new byte[0], false); return; }
            string[] lines = header.ToString().Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length != 3 || first[2] != "HTTP/1.1") { Respond(stream, 400, "text/plain", new byte[0], false); return; }
            string host = null, origin = null;
            for (int i = 1; i < lines.Length && lines[i].Length > 0; i++)
            {
                int colon = lines[i].IndexOf(':'); if (colon <= 0) { Respond(stream, 400, "text/plain", new byte[0], false); return; }
                string key = lines[i].Substring(0, colon), value = lines[i].Substring(colon + 1).Trim();
                if (key.Equals("Host", StringComparison.OrdinalIgnoreCase)) { if (host != null) { Respond(stream, 400, "text/plain", new byte[0], false); return; } host = value; }
                if (key.Equals("Origin", StringComparison.OrdinalIgnoreCase)) { if (origin != null) { Respond(stream, 400, "text/plain", new byte[0], false); return; } origin = value; }
            }
            bool head = first[0] == "HEAD";
            if (host != authority || (origin != null && origin != "http://" + authority)) { Respond(stream, 403, "text/plain", new byte[0], head); return; }
            if (first[0] != "GET" && !head) { Respond(stream, 405, "text/plain", new byte[0], false); return; }
            if (first[1] == "/status") { Respond(stream, 200, "application/json; charset=utf-8", status, head); return; }
            byte[] bytes;
            if (!assets.TryGetValue(first[1], out bytes)) { Respond(stream, 404, "text/plain", new byte[0], head); return; }
            Respond(stream, 200, types[first[1]], bytes, head);
        }
    }
    private static void Respond(Stream stream, int code, string type, byte[] bytes, bool head)
    {
        string header = "HTTP/1.1 " + code + " Response\r\nConnection: close\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.Length + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\r\n";
        byte[] start = System.Text.Encoding.ASCII.GetBytes(header); stream.Write(start, 0, start.Length);
        if (!head) stream.Write(bytes, 0, bytes.Length);
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; listener.Stop();
        // In-flight requests have a bounded timeout; no process or service is killed.
    }
}

public static class PivaneDesktopNative
{
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    public static void EnableDpiAwareness() { SetProcessDPIAware(); }
}
