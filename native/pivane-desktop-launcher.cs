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
            byte[] bytes = StartupAssetReader.Read(root, "public/" + files[i], 131072);
            if (i == 0)
            {
                string html = System.Text.Encoding.UTF8.GetString(bytes);
                bytes = System.Text.Encoding.UTF8.GetBytes(html.Replace("<head>", "<head>\n<meta name=\"startup-instance\" content=\"" + instance + "\">"));
            }
            assets.Add(routes[i], bytes); types.Add(routes[i], contentTypes[i]);
        }
        status = System.Text.Encoding.UTF8.GetBytes("{\"state\":\"starting\",\"instance\":\"" + instance + "\",\"generation\":\"\"}");
        // The service has a separate deterministic 40000-59999 allocation range.
        using (var ports = System.Security.Cryptography.RandomNumberGenerator.Create())
        {
            byte[] randomPort = new byte[4];
            for (int attempt = 0; attempt < 64; attempt++)
            {
                ports.GetBytes(randomPort);
                int requestedPort = attempt == 0 ? 0 : 60000 + (int)(BitConverter.ToUInt32(randomPort, 0) % 5536);
                var candidate = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, requestedPort);
                try { candidate.Start(8); }
                catch (System.Net.Sockets.SocketException error)
                {
                    candidate.Stop();
                    if (error.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse
                        || error.SocketErrorCode == System.Net.Sockets.SocketError.AccessDenied) continue;
                    throw;
                }
                int port = ((System.Net.IPEndPoint)candidate.LocalEndpoint).Port;
                if ((port >= 40000 && port < 60000) || Array.IndexOf(reservedPorts ?? new int[0], port) >= 0) { candidate.Stop(); continue; }
                listener = candidate; authority = "127.0.0.1:" + port; Url = "http://" + authority + "/"; break;
            }
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

// The bytes, identity, revision and final kernel path all come from the same
// opened object. Ancestor handles stay open without write/delete sharing until
// validation finishes, so a junction replacement cannot redirect the read.
internal static class StartupAssetReader
{
    [StructLayout(LayoutKind.Sequential)] private struct FileIdInfo { public ulong Volume; [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] Id; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicInfo { public long Created, Accessed, Written, Changed; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct StandardInfo { public long Allocation, Length; public uint Links; [MarshalAs(UnmanagedType.U1)] public bool Deleted; [MarshalAs(UnmanagedType.U1)] public bool Directory; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetFileType(Microsoft.Win32.SafeHandles.SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle handle, System.Text.StringBuilder path, uint count, uint flags);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] private static extern bool ReadId(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, out FileIdInfo value, uint size);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] private static extern bool ReadBasic(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, out BasicInfo value, uint size);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] private static extern bool ReadStandard(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, out StandardInfo value, uint size);
    private sealed class Opened : IDisposable
    {
        public Microsoft.Win32.SafeHandles.SafeFileHandle Handle;
        public FileIdInfo Id; public BasicInfo Basic; public StandardInfo Standard; public string Path;
        public Opened(string expected, bool directory)
        {
            // OPEN_REPARSE_POINT also exposes a final junction instead of following it.
            Handle=CreateFileW(expected, directory ? 0x80u : 0x80000000u, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            try
            {
                if (Handle.IsInvalid || GetFileType(Handle)!=1) throw new IOException("Startup asset is not a disk object.");
                Snapshot(out Id, out Basic, out Standard);
                Path=FinalPath();
                if (!String.Equals(Path, Normalize(expected), StringComparison.OrdinalIgnoreCase) || Standard.Directory!=directory || Standard.Deleted || (Basic.Attributes & 0x400)!=0) throw new IOException("Startup asset path or type is unsafe.");
            }
            catch { Handle.Dispose(); throw; }
        }
        private string FinalPath()
        {
            var text=new System.Text.StringBuilder(32769);
            uint size=GetFinalPathNameByHandleW(Handle,text,(uint)text.Capacity,0);
            if(size==0 || size>=text.Capacity) throw new IOException("Cannot resolve startup asset kernel path.");
            return Normalize(text.ToString());
        }
        private void Snapshot(out FileIdInfo id, out BasicInfo basic, out StandardInfo standard)
        {
            if(!ReadId(Handle,18,out id,(uint)Marshal.SizeOf(typeof(FileIdInfo))) || !ReadBasic(Handle,0,out basic,(uint)Marshal.SizeOf(typeof(BasicInfo))) || !ReadStandard(Handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo)))) throw new IOException("Cannot verify full startup asset identity.");
        }
        public void Verify()
        {
            FileIdInfo id; BasicInfo basic; StandardInfo standard; Snapshot(out id,out basic,out standard);
            bool same=Id.Volume==id.Volume && Convert.ToBase64String(Id.Id)==Convert.ToBase64String(id.Id) && Basic.Created==basic.Created && Basic.Written==basic.Written && Basic.Changed==basic.Changed && Basic.Attributes==basic.Attributes && Standard.Length==standard.Length && Standard.Links==standard.Links && Standard.Directory==standard.Directory && Standard.Deleted==standard.Deleted;
            if(!same || !String.Equals(Path,FinalPath(),StringComparison.Ordinal)) throw new IOException("Startup asset changed while reading.");
        }
        public void Dispose() { Handle.Dispose(); }
    }
    private static string Normalize(string value)
    {
        if(value.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase)) value="\\\\"+value.Substring(8);
        else if(value.StartsWith("\\\\?\\",StringComparison.Ordinal)) value=value.Substring(4);
        return System.IO.Path.GetFullPath(value).TrimEnd('\\');
    }
    public static byte[] Read(string root, string relative, int budget)
    {
        var ancestors=new System.Collections.Generic.List<Opened>();
        try
        {
            string current=System.IO.Path.GetFullPath(root); ancestors.Add(new Opened(current,true));
            string[] parts=relative.Split('/');
            for(int i=0;i<parts.Length;i++)
            {
                if(parts[i].Length==0 || parts[i]=="." || parts[i]==".." || parts[i].IndexOfAny(new char[]{'\\',':'})>=0) throw new IOException("Invalid startup asset path.");
                current=System.IO.Path.Combine(current,parts[i]);
                if(i<parts.Length-1) ancestors.Add(new Opened(current,true));
            }
            using(var file=new Opened(current,false))
            {
                long size=file.Standard.Length;
                if(size<0 || size>budget) throw new IOException("Startup asset exceeds budget.");
                byte[] bytes=new byte[(int)size];
                using(var stream=new FileStream(file.Handle,FileAccess.Read,4096,false))
                {
                    int offset=0;
                    while(offset<bytes.Length) { int read=stream.Read(bytes,offset,Math.Min(4096,bytes.Length-offset)); if(read==0) throw new IOException("Startup asset shrank while reading."); offset+=read; }
                    if(stream.ReadByte()!=-1) throw new IOException("Startup asset grew while reading.");
                    file.Verify(); foreach(var directory in ancestors) directory.Verify();
                }
                return bytes;
            }
        }
        finally { for(int i=ancestors.Count-1;i>=0;i--) ancestors[i].Dispose(); }
    }
}

public static class PivaneDesktopNative
{
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    public static void EnableDpiAwareness() { SetProcessDPIAware(); }
}
