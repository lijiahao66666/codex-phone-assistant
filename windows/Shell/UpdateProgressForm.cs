namespace CodexPhone;

internal sealed class UpdateProgressForm : Form
{
    private readonly Label status = new() {
        AutoSize = false,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
    };
    private readonly ProgressBar progress = new() {
        Dock = DockStyle.Fill,
        Minimum = 0,
        Maximum = 100,
        Style = ProgressBarStyle.Marquee,
    };
    private readonly Button cancel = new() {
        Text = "取消",
        AutoSize = true,
        Anchor = AnchorStyles.Right,
    };
    private readonly CancellationTokenSource cancellation;
    private bool completed;

    public UpdateProgressForm(string version, CancellationTokenSource cancellation)
    {
        this.cancellation = cancellation;
        Text = "正在更新 codex手机助手";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(460, 150);
        Padding = new Padding(20);

        status.Text = $"正在下载 {version}…";
        var buttonRow = new FlowLayoutPanel {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Padding = new Padding(0, 12, 0, 0),
        };
        buttonRow.Controls.Add(cancel);
        var layout = new TableLayoutPanel {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.Controls.Add(status, 0, 0);
        layout.Controls.Add(progress, 0, 1);
        layout.Controls.Add(buttonRow, 0, 2);
        Controls.Add(layout);

        cancel.Click += (_, _) => {
            cancel.Enabled = false;
            status.Text = "正在取消…";
            cancellation.Cancel();
        };
        FormClosing += (_, _) => {
            if (!completed) cancellation.Cancel();
        };
    }

    public void SetProgress(int percent)
    {
        if (IsDisposed) return;
        if (InvokeRequired) {
            BeginInvoke(() => SetProgress(percent));
            return;
        }
        if (progress.Style != ProgressBarStyle.Continuous) progress.Style = ProgressBarStyle.Continuous;
        progress.Value = Math.Clamp(percent, 0, 100);
        status.Text = percent >= 100 ? "校验完成，正在启动安装程序…" : $"正在下载更新… {percent}%";
        cancel.Enabled = percent < 100;
    }

    public void Complete()
    {
        completed = true;
        if (!IsDisposed) Close();
    }
}
