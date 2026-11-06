# Windows 桌面端

`Shell/` 是 WinForms + WebView2 宿主。程序启动随包 Node 后台服务，读取 `runtime-entry.txt`，打开本机配对面板；关闭窗口只隐藏到托盘，再次运行程序会唤回已有窗口。

## 构建

```powershell
npm run build:windows
```

构建脚本会：

1. 发布自包含的 `win-x64` .NET 程序；
2. 下载并校验 Node.js 22.17.1；
3. 复制 `src/`、`public/` 和依赖；
4. 生成便携目录与 ZIP；
5. 找到 NSIS 时生成当前用户安装器。

输出在 `build/windows/`。安装器默认写入 `%LOCALAPPDATA%\Programs\codex-phone-assistant`，WebView2 用户数据写入 `%LOCALAPPDATA%\codex-phone-assistant\WebView2`。

## 已验证

- `\\.\pipe\codex-ipc` 握手
- Windows 项目与历史路径
- H5 配对、任务列表、历史、发送和停止
- 托盘隐藏与再次启动唤回
- 安装、卸载和重新安装

图片上传和预览在 Windows 默认关闭。未签名安装器可能触发 SmartScreen。

## 安装

当前[项目下载页](https://codex.air-inc.top/download/)的 Windows 下载仍在准备中。使用本地构建的
`build/windows/codex-phone-assistant-windows-x64-setup.exe` 时，按以下步骤操作：

1. 双击安装器，允许当前用户安装。需要管理员权限吗？不需要。
2. 安装程序会写入 `%LOCALAPPDATA%\Programs\codex-phone-assistant`，并创建开始菜单快捷方式。
3. 如果 Windows SmartScreen 提示“Windows 已保护你的电脑”，先确认安装包来源可信，再选择“更多信息” → “仍要运行”。
4. 通过开始菜单启动 `codex手机助手`。

> 当前安装包未签名。不要绕过来源不明的 SmartScreen 警告。

## 首次配对

1. 确认 Windows 上已登录 Codex 桌面版。
2. 启动 `codex手机助手`，等待窗口显示“手机已连接”或点击“生成配对码”。
3. 在手机浏览器打开 https://codex.air-inc.top/，输入配对码并在电脑上确认。
4. 也可以扫描电脑窗口中的二维码直接配对。
5. 配对成功后，在手机端选择任务即可查看和操作。

## 托盘与退出

- 点击窗口关闭按钮只会隐藏到系统托盘，手机连接保持有效。
- 双击托盘图标或托盘菜单中的“打开 codex手机助手”可恢复窗口。
- 再次运行 `codex-phone-assistant.exe` 也会唤回已有窗口，不会启动第二个后台进程。
- 从托盘菜单选择“退出”会关闭窗口并终止随包 Node 进程。

## 卸载

1. 打开“设置” → “应用” → “已安装的应用”。
2. 找到 `codex手机助手`，选择“卸载”。
3. 也可运行安装目录中的 `卸载.exe`。

卸载会删除程序目录和当前用户卸载项。配对凭据位于用户配置目录，不会由安装器自动删除；如需彻底移除，请在应用内先撤销设备配对，再手动清理 `%USERPROFILE%\.config\codex-hub`。
