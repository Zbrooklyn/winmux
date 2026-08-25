// WinMux tray icon — shows while the engine is alive, so shells running in the
// background are visible and stoppable when Obsidian is closed.
// Build: csc /nologo /target:winexe /out:winmux-tray.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll WinMuxTray.cs
// Args: [instance.json path] [Obsidian.exe path]
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class WinMuxTray : ApplicationContext {
    NotifyIcon icon; ContextMenuStrip menu; System.Windows.Forms.Timer timer;
    ToolStripMenuItem status, openItem, stopItem, quitItem;
    string instanceFile, obsidianExe; int port; int misses;
    Icon iconIdle, iconWork;

    static void Main(string[] args) {
        bool created;
        using (var mutex = new Mutex(true, "Local\\WinMuxTray", out created)) {
            if (!created) return; // already showing
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new WinMuxTray(args));
        }
    }

    WinMuxTray(string[] args) {
        var home = Environment.GetEnvironmentVariable("USERPROFILE") ?? ".";
        instanceFile = args.Length > 0 ? args[0] : Path.Combine(home, ".winmux", "instance.json");
        obsidianExe = args.Length > 1 ? args[1] : Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? home, "Programs", "Obsidian", "Obsidian.exe");
        iconIdle = MakeIcon(false); iconWork = MakeIcon(true);
        menu = new ContextMenuStrip();
        status = new ToolStripMenuItem("WinMux — starting…") { Enabled = false };
        openItem = new ToolStripMenuItem("Open Obsidian", null, (s, e) => OpenObsidian());
        stopItem = new ToolStripMenuItem("Stop engine (ends all shells)", null, (s, e) => StopEngine());
        quitItem = new ToolStripMenuItem("Hide icon (keep shells running)", null, (s, e) => Exit());
        menu.Items.AddRange(new ToolStripItem[] { status, new ToolStripSeparator(), openItem, stopItem, new ToolStripSeparator(), quitItem });
        icon = new NotifyIcon { Icon = iconIdle, Text = "WinMux", ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += (s, e) => OpenObsidian();
        timer = new System.Windows.Forms.Timer { Interval = 3000 };
        timer.Tick += (s, e) => Poll();
        timer.Start();
        Poll();
        Promote();
    }

    // Windows 11 parks new tray icons behind the chevron; promote ours so it is actually visible.
    void Promote() {
        try {
            var exe = Application.ExecutablePath;
            using (var root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings")) {
                if (root == null) return;
                foreach (var name in root.GetSubKeyNames()) {
                    using (var k = root.OpenSubKey(name, true)) {
                        var path = k == null ? null : k.GetValue("ExecutablePath") as string;
                        if (path == null || !string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) continue;
                        var v = k.GetValue("IsPromoted");
                        if (!(v is int) || (int)v != 1) k.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                    }
                }
            }
        } catch { }
    }

    void Poll() {
        try {
            var j = File.ReadAllText(instanceFile);
            var m = Regex.Match(j, "\"port\"\\s*:\\s*(\\d+)");
            if (!m.Success) throw new Exception("no port");
            port = int.Parse(m.Groups[1].Value);
            var info = Get("/api/info");
            var sessions = Regex.Match(info, "\"sessions\"\\s*:\\s*(\\d+)"); var recoverable = Regex.Match(info, "\"recoverable\"\\s*:\\s*(\\d+)");
            var grace = Regex.Match(info, "\"detachGraceSecs\"\\s*:\\s*(\\d+)");
            int n = sessions.Success ? int.Parse(sessions.Groups[1].Value) : 0;
            bool bg = grace.Success && grace.Groups[1].Value == "0";
            string text = n == 1 ? "WinMux — 1 shell running" : "WinMux — " + n + " shells running";
            if (!bg) text += " (not background mode)";
            status.Text = text + (recoverable.Success ? "  ·  " + recoverable.Groups[1].Value + " recoverable" : "");
            icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
            icon.Icon = n > 0 ? iconWork : iconIdle;
            misses = 0;
        } catch {
            if (++misses >= 3) Exit(); // engine gone → icon goes away
        }
    }

    string Get(string path) {
        var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Timeout = 1500; req.Method = "GET";
        using (var r = (HttpWebResponse)req.GetResponse()) using (var sr = new StreamReader(r.GetResponseStream())) return sr.ReadToEnd();
    }
    void Post(string path) {
        var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Timeout = 3000; req.Method = "POST"; req.ContentLength = 0;
        try { using (var r = (HttpWebResponse)req.GetResponse()) { } } catch { }
    }

    void OpenObsidian() {
        try { Process.Start(new ProcessStartInfo(obsidianExe) { UseShellExecute = true }); }
        catch { try { Process.Start(new ProcessStartInfo("obsidian://open") { UseShellExecute = true }); } catch { } }
    }

    void StopEngine() {
        var r = MessageBox.Show("Stop the WinMux engine? Every running shell ends (scrollback stays recoverable).", "WinMux", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
        if (r != DialogResult.OK) return;
        Post("/api/shutdown");
        Exit();
    }

    void Exit() { timer.Stop(); icon.Visible = false; icon.Dispose(); Application.Exit(); }

    // Runtime-drawn icon: rounded square, ">_" glyph; accent fill when shells are running.
    static Icon MakeIcon(bool active) {
        var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp)) {
            g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
            using (var path = Rounded(new Rectangle(1, 1, 30, 30), 7))
            using (var fill = new SolidBrush(active ? Color.FromArgb(138, 92, 245) : Color.FromArgb(70, 70, 76)))
                g.FillPath(fill, path);
            using (var pen = new Pen(Color.White, 3.2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round }) {
                g.DrawLines(pen, new[] { new PointF(9, 10), new PointF(15, 16), new PointF(9, 22) });
                g.DrawLine(pen, 17, 23, 24, 23);
            }
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
    static GraphicsPath Rounded(Rectangle r, int d) {
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure(); return p;
    }
}
