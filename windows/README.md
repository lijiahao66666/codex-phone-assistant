# Windows 安装与使用

Windows 客户端是 WinForms + WebView2 宿主，负责启动随包 Node 后台、显示本机配对面板，并通过本地命名管道连接 Codex Desktop。

[返回项目首页](../README.md) · [手机端能力说明](../docs/CODEX-CAPABILITIES.md)

## 下载

从 [GitHub Releases](https://github.com/lijiahao66666/codex-phone-assistant/releases/tag/v0.1.1) 下载：

- [Windows 安装包](https://github.com/lijiahao66666/codex-phone-assistant/releases/download/v0.1.1/codex-phone-assistant-windows-x64-setup.exe)
- [Windows 便携版 ZIP](https://github.com/lijiahao66666/codex-phone-assistant/releases/download/v0.1.1/codex-phone-assistant-windows-x64.zip)
- [SHA-256 校验值](https://github.com/lijiahao66666/codex-phone-assistant/releases/download/v0.1.1/SHA256SUMS.txt)

## 系统要求

- Windows 10 或 Windows 11，x64
- Microsoft Edge WebView2 Runtime
- 电脑上已安装并登录 Codex Desktop

安装版自带 .NET 和 Node.js 运行时，用户不需要另行安装。

## 安装与首次打开

### 安装步骤

1. 运行 `codex-phone-assistant-windows-x64-setup.exe`。
2. 安装位置为 `%LOCALAPPDATA%\Programs\codex-phone-assistant`，无需管理员权限。
3. 如果 Windows SmartScreen 提示“Windows 已保护你的电脑”，先确认文件来源和 SHA-256，再选择“更多信息” → “仍要运行”。
4. 从开始菜单启动 `codex手机助手`。

> 当前安装包未签名。不要绕过来源不明的 SmartScreen 警告。

![Windows 客户端配对界面](../docs/assets/windows-pairing.png)

## 首次配对

1. 确认 Windows 上的 Codex Desktop 已登录。
2. 打开 `codex手机助手`；如果之前已经配对，窗口会显示“手机已连接”。
3. 点击“生成配对码”。
4. 在手机浏览器打开 <https://codex.air-inc.top/>，输入配对码并在 Windows 客户端确认；也可以扫描电脑上的二维码。
5. 配对成功后，在手机端打开左上角任务面板并选择任务。

## 手机端限制

手机端不会自动拥有 Codex Desktop 的全部设置。当前不能：

- 新建任务或项目
- 创建、修改、暂停或清除目标；目标信息仅只读
- 选择插件、Apps、MCP 或连接器
- 选择模型、推理强度、cwd、Git 分支、worktree 或执行环境
- 重命名、归档、删除或移动任务和项目

手机端可以切换 `Plan` / `Default` 协作模式，但这不是“目标模式”。完整对照见 [手机端与 Codex 能力对照](../docs/CODEX-CAPABILITIES.md)。

## 托盘与退出

- 点击窗口关闭按钮只会隐藏到系统托盘，后台 Node 服务和手机连接继续运行。
- 双击托盘图标，或选择托盘菜单中的“打开 codex手机助手”，可恢复窗口。
- 再次运行 `codex-phone-assistant.exe` 会唤回已有窗口，不会启动第二个后台进程。
- 选择托盘菜单中的“退出”会结束窗口和随包 Node 进程。

## 卸载

1. 打开“设置” → “应用” → “已安装的应用”。
2. 找到 `codex手机助手`，选择“卸载”。
3. 也可以运行安装目录中的 `卸载.exe`。

卸载会删除程序目录和卸载项。配对凭据位于 `%USERPROFILE%\.config\codex-hub`；彻底清理前应先在应用内移除设备配对。

## 从源码构建

要求 Node.js 22.17+、.NET 8 SDK；生成 NSIS 安装器还需要 NSIS。

```powershell
npm ci
npm test
npm run build:windows
```

输出位于 `build/windows/`：

- `dist/codex-phone-assistant.exe`
- `codex-phone-assistant-windows-x64.zip`
- `codex-phone-assistant-windows-x64-setup.exe`

## 故障排查

- **一直显示“电脑未连接”**：确认 `codex-phone-assistant.exe` 正在运行，Codex Desktop 已登录，并检查 HUB_ORIGIN 是否为 <https://codex.air-inc.top>。
- **无法通过命名管道连接**：确认 `\\.\pipe\codex-ipc` 存在，并重启 Codex Desktop 与手机助手。
- **安装文件被 SmartScreen 拦截**：核对 SHA-256 和来源后，才使用“更多信息” → “仍要运行”。
- **图片或文件按钮未出现**：Windows 包默认关闭媒体上传和预览；文字消息和停止任务不受影响。

## 验证状态

Windows 11 x64 已完成命名管道、项目与任务读取、H5 配对、历史、发送、停止、托盘唤回以及安装/卸载测试。150% 系统缩放下窗口按 Per-Monitor V2 原生渲染，避免整窗位图放大造成的模糊。
