# Windows 宿主和打包候选

这是尚未验收或发布的开发候选，不含可用的 Windows 连接器。`Shell` 是 WinForms 和 WebView2 窗口：从指定入口启动随包 Node 进程，读取 `PANEL_URL=`，将本地配对面板显示在窗口里；关窗隐藏到托盘，从托盘退出时结束子进程。系统需要可用的 Microsoft Edge WebView2 Runtime。宿主在运行时不需要用户额外安装 .NET 或 Node。

在 macOS 上构建候选需要 `dotnet` 8 SDK、`makensis`、`node`、`curl`、`unzip`、`sips` 和网络：

```sh
DOTNET=/path/to/dotnet sh build-macos.sh /path/to/windows-runtime windows-app-runtime.mjs /absolute/path/setup.exe
```

运行时目录与入口必须显式提供，入口必须是该目录下的 `.mjs` 文件。目录会完整复制进安装包，只能使用经过检查、不含凭据和私人数据的发布目录。脚本下载官方 Node 22.17.1 Windows x64 并检查官方 SHA256，发布自包含 .NET 程序，再生成当前用户安装的 NSIS 安装器。`test-fixture` 仅用于检查构建流程，不是产品后端，不可交付。

Windows 端仍需实现并验证桌面 IPC、凭据 ACL、媒体安全处理和连接器；在真实 Windows 测试 WebView2 本地请求鉴权、确认配对唤窗、关闭/退出、安装/卸载和后台清理前，不能把此候选作为可用安装包发布。未签名的安装器可能触发 SmartScreen。

官方 Node 下载不稳定时可通过 `NODE_ARCHIVE_URL` 指向同版本镜像；哈希仍取官方清单，不匹配即终止构建。
