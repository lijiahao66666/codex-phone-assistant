using System.Diagnostics;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexPhone;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var guard = new Mutex(true, @"Local\codex-phone-assistant", out var created);
        if (!created)
        {
            MessageBox.Show("codex手机助手已在运行，请从系统托盘打开。", "codex手机助手");
            return;
        }
        Application.Run(new PhoneForm());
    }
}

internal sealed class PhoneForm : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon tray = new();
    private Process? runtime;
    private Uri? panelUri;
    private bool quitting;

    public PhoneForm()
    {
        Text = "codex手机助手";
        Width = 500;
        Height = 660;
        MinimumSize = new Size(360, 450);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(web);
        var iconPath = Path.Combine(AppContext.BaseDirectory, "app.ico");
        Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
        tray.Icon = Icon;
        tray.Text = Text;
        tray.Visible = true;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 codex手机助手", null, (_, _) => ShowPanel());
        menu.Items.Add("退出", null, (_, _) => { quitting = true; Close(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => ShowPanel();
        Shown += async (_, _) => await StartAsync();
        FormClosing += OnClosing;
    }

    private void ShowPanel()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private async Task StartAsync()
    {
        try
        {
            await web.EnsureCoreWebView2Async();
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.webkit={messageHandlers:{pairRequest:{postMessage:x=>window.chrome.webview.postMessage(x)}}};");
            web.CoreWebView2.WebMessageReceived += (_, e) => {
                if (panelUri != null && Uri.TryCreate(e.Source, UriKind.Absolute, out var source) &&
                    source.Scheme == panelUri.Scheme && source.Host == panelUri.Host && source.Port == panelUri.Port &&
                    e.TryGetWebMessageAsString() == "pending") ShowPanel();
            };
            web.CoreWebView2.NavigationStarting += (_, e) => {
                if (panelUri == null || !Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) ||
                    target.Scheme != panelUri.Scheme || target.Host != panelUri.Host || target.Port != panelUri.Port) e.Cancel = true;
            };

            var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "node.exe")) {
                WorkingDirectory = Path.Combine(AppContext.BaseDirectory, "runtime"),
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            var entry = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "runtime-entry.txt")).Trim();
            if (string.IsNullOrEmpty(entry) || Path.GetFileName(entry) != entry || !entry.EndsWith(".mjs", StringComparison.Ordinal))
                throw new InvalidOperationException("后台服务入口无效");
            start.ArgumentList.Add(Path.Combine(start.WorkingDirectory, entry));
            start.Environment.Remove("NODE_OPTIONS");
            start.Environment.Remove("NODE_PATH");
            runtime = Process.Start(start) ?? throw new InvalidOperationException("无法启动后台服务");
            runtime.EnableRaisingEvents = true;
            runtime.Exited += (_, _) => { if (!quitting && IsHandleCreated) BeginInvoke(ShowError); };
            _ = runtime.StandardError.ReadToEndAsync();
            var line = await runtime.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            if (line is null || !line.StartsWith("PANEL_URL=", StringComparison.Ordinal) ||
                !Uri.TryCreate(line[10..], UriKind.Absolute, out var url) || url.Scheme != "http" || url.Host != "127.0.0.1")
                throw new InvalidOperationException("后台服务未就绪");
            panelUri = url;
            web.Source = url;
            _ = runtime.StandardOutput.ReadToEndAsync();
        }
        catch (Exception ex) { MessageBox.Show(this, $"启动失败：{ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void ShowError() => MessageBox.Show(this, "后台服务已退出，请退出助手后重新打开。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
        quitting = true;
        tray.Visible = false;
        tray.Dispose();
        if (runtime is { HasExited: false }) { runtime.Kill(entireProcessTree: true); runtime.WaitForExit(5000); }
        runtime?.Dispose();
    }
}
