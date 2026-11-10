# macOS 安装与使用

macOS 客户端使用 Swift、WKWebView 和菜单栏入口，随包 Node 后台通过本地 IPC 连接 Codex Desktop。当前安装包适用于 Apple 芯片，要求 macOS 12 或更新版本。

[返回项目首页](../README.md) · [手机端能力说明](../docs/CODEX-CAPABILITIES.md) · [版本说明与已知限制](../docs/stable48-release-notes-2026-11-09.md)

## 下载

从[项目下载页](https://codex.air-inc.top/download/)或 [GitHub Releases](https://github.com/lijiahao66666/codex-phone-assistant/releases)获取 macOS Apple Silicon 安装包和对应的 SHA-256 校验值。

## 系统要求

- Apple 芯片 Mac（arm64）
- macOS 12 或更新版本
- 电脑上已安装并登录 Codex Desktop

Intel Mac 当前未提供安装包。

> 本版使用本地 ad-hoc 签名，未经过 Apple 公证，也没有 Developer ID 签名。只有在确认来源可信、SHA-256 正确时才继续打开；无法验证来源时应停止安装。

## 安装与首次打开

### 1. 移到“应用程序”

打开下载的 DMG，将 `codex手机助手` 拖到 `Applications` 文件夹。

![将 codex手机助手拖到 Applications](../docs/assets/mac-install.png)

### 2. 从应用程序中启动

打开“应用程序”文件夹并启动 `codex手机助手`。如果 macOS 显示“未打开”，点击“完成”。

![macOS 未打开提示，点击完成](../docs/assets/mac-blocked.png)

### 3. 在隐私与安全性中允许打开

打开“系统设置” → “隐私与安全性”，向下找到被阻止的 `codex手机助手`，点击“仍要打开”。

![隐私与安全性中显示仍要打开](../docs/assets/mac-privacy.png)

### 4. 再次确认

在系统提示中再次点击“仍要打开”，并按系统要求完成验证。

![再次确认仍要打开 codex手机助手](../docs/assets/mac-confirm.png)

完成后会显示本机配对窗口：

![codex手机助手的手机配对界面](../docs/assets/mac-pair.png)

## 首次配对

1. 确认 Mac 上的 Codex Desktop 已登录。
2. 打开 `codex手机助手`，点击“生成配对码”。
3. 在手机浏览器打开 <https://codex.air-inc.top/>，输入配对码并在 Mac 客户端确认；也可以扫描电脑上的二维码。
4. 配对成功后，在手机端打开左上角任务面板并选择任务。

## 新聊天、历史恢复和模型

- 在项目列表或顶部选择项目后，可创建手机助手持有的新聊天；首次发送时才创建任务。
- 历史聊天在连接期间可先以只读方式显示；助手确认归属并恢复实时状态后，才能发送消息。已有 owner 或写入结果不明时会保留相应保护。
- 模型和推理强度使用电脑返回的可用列表，只能在任务空闲且没有待确认写入时切换。

部分聊天冷连接曾超过 30 秒；显示只读历史不等于实时连接完成。冷连接速度优化留到下一期。

## 手机端限制

手机端是电脑版 Codex 的伴生界面。新建项目、目标操作、插件、Apps、MCP、Git 分支、worktree 和执行环境尚未接入，目标信息目前只能查看。H5 暂时隐藏未读蓝点；跨端已读同步、桌面主动接管与持有写入权时归档、礼品卡聊天旧恢复锁留到下一期。完整边界见 [版本说明](../docs/stable48-release-notes-2026-11-09.md) 和 [手机端与 Codex 能力对照](../docs/CODEX-CAPABILITIES.md)。

## 托盘与退出

- 窗口顶部提供“检查更新…”和“退出助手”按钮；更新安装需要确认。
- 关闭窗口会隐藏到菜单栏，后台服务和手机连接继续运行。
- 从菜单栏图标选择“打开 codex手机助手”可恢复窗口。
- 从菜单栏选择“退出 codex手机助手”会结束窗口和随包 Node 进程。助手持有的任务仍在运行、存在未确认写入或状态无法确认，以及操作或附件仍在处理时，会保留进程并提示。

## 卸载

1. 使用窗口顶部“退出助手”或菜单栏退出 `codex手机助手`。
2. 打开“应用程序”文件夹，将 `codex手机助手` 移到废纸篓。
3. 如需彻底清理，请先在应用内移除设备配对，再清理 `~/.config/codex-hub`。

## 从源码构建

要求 macOS、Xcode 命令行工具、Node.js 22、Python 3 和网络连接。

```sh
npm ci
npm test
npm run build:macos
```

默认输出为 `build/codex手机助手.app`。构建会执行本地 ad-hoc 签名和校验，不包含 Apple Developer ID 签名或公证。

应用内更新使用官方 Sparkle 2.10.1，支持手动检查和自动检查。正式打包需配置更新源、EdDSA 公钥和递增构建号，具体步骤与退出保护边界见 [应用内更新](UPDATES.md)。未配置更新源与公钥的本地构建会关闭更新检查。

## 故障排查

- **点击打开后没有反应**：确认安装包来自 GitHub Release 或项目下载页，并核对 SHA-256。
- **被 macOS 阻止**：按上面的“隐私与安全性”步骤操作；不要在无法确认来源时绕过系统保护。
- **一直显示“电脑未连接”**：确认 Codex Desktop 已登录且手机助手后台仍在运行。
- **图片或文件按钮未出现**：检查桌面端媒体能力开关和所访问文件的权限范围。

## 验证状态

本轮包括自动化回归、Mac 助手与 H5 专用聊天实测；不同版本的验收样本不能合并为最终版本全场景通过。长会话传输仍有波动，多人长期负载与真实 iPhone 键盘、安全区及相机尚未充分验证。具体结果及限制见 [版本说明](../docs/stable48-release-notes-2026-11-09.md)。
