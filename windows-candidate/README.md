# Windows 宿主和安装包

`Shell` 是 WinForms 和 WebView2 窗口：从指定入口启动随包 Node 进程，读取 `PANEL_URL=`，将本地配对面板显示在窗口里；关窗隐藏到托盘，再次运行程序会唤回现有窗口，从托盘退出时结束子进程。宿主在运行时不需要用户额外安装 .NET 或 Node。WebView2 用户数据保存在 `%LOCALAPPDATA%\codex-phone-assistant\WebView2`，不会写进安装目录。

在 Windows 上构建：

```powershell
.\windows-candidate\build-windows.ps1 -Force
```

脚本使用项目内 `.tools\dotnet`（或系统 `dotnet`）发布自包含 .NET 程序，下载并校验官方 Node 22.17.1 Windows x64，复制当前运行时和 `node_modules`，生成便携目录、ZIP 和 NSIS 安装器。安装器默认安装到 `%LOCALAPPDATA%\Programs\codex-phone-assistant`，按当前用户权限注册卸载项，不需要管理员权限。`test-fixture` 仅用于检查构建流程，不是产品后端。

当前 Windows 版已验证：命名管道 `\\.\pipe\codex-ipc` 握手、项目与任务列表、H5 配对、任务历史读取、H5 发送与停止、WebView2 本地面板、关闭到托盘及再次启动唤回、便携版与安装版启动，以及安装/卸载生命周期。配对凭据使用当前用户 ACL；图片上传和预览在 Windows 包中默认关闭。未签名安装器可能触发 SmartScreen。

官方 Node 下载不稳定时可通过 `NODE_ARCHIVE_URL` 指向同版本镜像；哈希仍取官方清单，不匹配即终止构建。
