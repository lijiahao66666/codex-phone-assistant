using System.Diagnostics;
using System.Text;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexPhone;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        ApplicationConfiguration.Initialize();
        using var guard = new Mutex(true, @"Local\codex-phone-assistant", out var created);
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\codex-phone-assistant-show");
        using var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\codex-phone-assistant-quit");
        if (!created)
        {
            if (args.Contains("--quit", StringComparer.OrdinalIgnoreCase)) quitEvent.Set();
            else showEvent.Set();
            return;
        }
        Application.Run(new PhoneForm(showEvent, quitEvent));
    }
}

internal sealed class PhoneForm : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon tray = new();
    private readonly UpdateService? updates;
    private readonly ToolStripMenuItem checkUpdateItem;
    private readonly ToolStripMenuItem autoUpdateItem;
    private readonly System.Windows.Forms.Timer updateTimer = new() { Interval = 6 * 60 * 60 * 1000 };
    private Process? runtime;
    private Uri? panelUri;
    private bool quitting;
    private bool checkingUpdates;

    public PhoneForm(EventWaitHandle showEvent, EventWaitHandle quitEvent)
    {
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
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
        checkUpdateItem = new ToolStripMenuItem("检查更新…", null, async (_, _) => await CheckForUpdatesAsync(true));
        autoUpdateItem = new ToolStripMenuItem("自动检查更新") { Checked = ReadAutoUpdateSetting() };
        autoUpdateItem.Click += (_, _) => {
            autoUpdateItem.Checked = !autoUpdateItem.Checked;
            WriteAutoUpdateSetting(autoUpdateItem.Checked);
            if (autoUpdateItem.Checked) updateTimer.Start(); else updateTimer.Stop();
        };
        menu.Items.Add(checkUpdateItem);
        menu.Items.Add(autoUpdateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => { quitting = true; Close(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => ShowPanel();
        updates = BuildInfo.UpdateFeed is Uri feed && BuildInfo.Build > 0 && !string.IsNullOrWhiteSpace(BuildInfo.UpdatePublicKey)
            ? new UpdateService(feed, BuildInfo.Build, BuildInfo.UpdatePublicKey)
            : null;
        updateTimer.Tick += async (_, _) => await CheckForUpdatesAsync(false);
        Shown += (_, _) => _ = StartAfterShownAsync();
        FormClosing += OnClosing;
        var activation = new Thread(() =>
        {
            while (!quitting)
            {
                var signal = WaitHandle.WaitAny([showEvent, quitEvent]);
                if (quitting || !IsHandleCreated) continue;
                if (signal == 1) BeginInvoke(() => { quitting = true; Close(); });
                else BeginInvoke(ShowPanel);
            }
        }) { IsBackground = true };
        activation.Start();
    }

    private async Task StartAfterShownAsync()
    {
        await StartAsync();
        if (updates is null || !autoUpdateItem.Checked) return;
        updateTimer.Start();
        await Task.Delay(TimeSpan.FromSeconds(8));
        if (!quitting) await CheckForUpdatesAsync(false);
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
            var webViewData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "codex-phone-assistant",
                "WebView2");
            Directory.CreateDirectory(webViewData);
            var webViewEnvironment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: webViewData);
            await web.EnsureCoreWebView2Async(webViewEnvironment);
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
            if (string.IsNullOrEmpty(entry) || Path.IsPathRooted(entry) || !entry.EndsWith(".mjs", StringComparison.Ordinal))
                throw new InvalidOperationException("后台服务入口无效");
            var runtimeRoot = Path.GetFullPath(start.WorkingDirectory) + Path.DirectorySeparatorChar;
            var entryPath = Path.GetFullPath(Path.Combine(start.WorkingDirectory, entry));
            if (!entryPath.StartsWith(runtimeRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(entryPath))
                throw new InvalidOperationException("后台服务入口无效");
            start.ArgumentList.Add(entryPath);
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

    private async Task CheckForUpdatesAsync(bool userInitiated)
    {
        if (checkingUpdates || quitting) return;
        if (updates is null) {
            if (userInitiated) MessageBox.Show(this, "当前构建没有配置 Windows 更新源。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        checkingUpdates = true;
        checkUpdateItem.Enabled = false;
        var oldText = checkUpdateItem.Text;
        checkUpdateItem.Text = "正在检查更新…";
        try {
            var release = await updates.CheckAsync();
            if (release is null) {
                if (userInitiated) MessageBox.Show(this, $"当前已是最新版本 {BuildInfo.Version}（构建 {BuildInfo.Build}）。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            updateTimer.Stop();
            var answer = MessageBox.Show(
                this,
                $"发现新版本 {release.Version}（构建 {release.Build}）。\n当前版本 {BuildInfo.Version}（构建 {BuildInfo.Build}）。\n\n是否打开下载页面？请自行下载并安装新版本。",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Information,
                MessageBoxDefaultButton.Button1);
            if (answer == DialogResult.Yes) Process.Start(new ProcessStartInfo("https://codex.air-inc.top/download/") { UseShellExecute = true });
        } catch (OperationCanceledException) {
        } catch (UpdateException error) {
            if (userInitiated) MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else tray.ShowBalloonTip(5000, "无法检查更新", error.Message, ToolTipIcon.Warning);
        } catch (Exception error) {
            if (userInitiated) MessageBox.Show(this, $"检查更新失败：{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            else tray.ShowBalloonTip(5000, "无法检查更新", "更新服务器暂时不可用。", ToolTipIcon.Warning);
        } finally {
            checkingUpdates = false;
            checkUpdateItem.Enabled = true;
            checkUpdateItem.Text = oldText;
            if (autoUpdateItem.Checked && !quitting) updateTimer.Start();
        }
    }

    private static bool ReadAutoUpdateSetting()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\codex-phone-assistant");
        return key?.GetValue("AutoCheckForUpdates") is not int value || value != 0;
    }

    private static void WriteAutoUpdateSetting(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\codex-phone-assistant");
        key.SetValue("AutoCheckForUpdates", enabled ? 1 : 0, RegistryValueKind.DWord);
    }

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
        quitting = true;
        updateTimer.Stop();
        tray.Visible = false;
        tray.Dispose();
        if (runtime is { HasExited: false }) { runtime.Kill(entireProcessTree: true); runtime.WaitForExit(5000); }
        runtime?.Dispose();
    }
}
