# Codex 手机助手

在手机上通过 H5 查看和控制本机 Codex 任务的桌面助手。项目包括电脑助手、电脑配对面板和手机 H5。已有聊天通过 Codex Desktop 本地 IPC 同步；新聊天与确认恢复的历史聊天由助手运行，并同步到桌面。

> 这不是 OpenAI 官方产品。桌面端依赖未公开、可能随 Codex 版本变化的 IPC 协议。
>
> 手机端是电脑版 Codex 的伴生界面。目标编辑、插件和应用仍未接入；支持新聊天、历史恢复、模型和推理强度选择。已知限制和验收范围见 [stable48 验收记录](docs/stable48-release-notes-2026-11-09.md)。
>
> 仓库目前为私有。图片、GIF 和 Release 附件需要登录有访问权限的 GitHub 账号；第三方 Markdown 阅读器可能无法加载私有仓库媒体。

> 发布状态：stable48 的 H5、中转及本机候选已用于验收；正式 Mac 安装包、自动更新源和下载页仍待签名及发布。当前下载页的安装包不是 stable48。详见 [发布与服务器目录状态](docs/release-and-server-status.md)。

![电脑与手机同时查看同一 Codex 任务](docs/assets/desktop-phone-view.png)

手机发送消息后，电脑端同步收到并更新任务：

![手机发送消息，电脑收到消息的演示](docs/assets/phone-send-demo.gif)

[查看原始 MP4 演示](docs/assets/phone-send-demo.mp4)

## 下载

从下载页获取当前安装包，或在 GitHub Releases 查看版本和校验文件：

- [手机助手下载页](https://codex.air-inc.top/download/)
- [GitHub Releases](https://github.com/lijiahao66666/codex-phone-assistant/releases)

stable48 的 Mac 与 H5 已完成专项实机/隔离验收；Windows 0.3.49 已完成构建、更新器组件测试与 Windows 回归，尚缺第二台真实电脑的公网跨版本升级验收。

安装步骤：

- [Windows 安装与使用](windows/README.md)
- [macOS 安装与使用](macos/README.md)

## 手机端能力概览

| 已支持 | 未支持 |
| --- | --- |
| 配对和切换已配对的电脑 | 新建项目 |
| 查看项目、实时任务列表，选择项目新建聊天（macOS） | 项目创建；聊天重命名、移动、归档或删除 |
| 查看历史、工具活动、文件变更和子智能体摘要 | 在手机上选择目标模式 |
| 发送消息、补充输入、停止任务，确认恢复历史聊天（macOS） | 选择插件、Apps、MCP 或连接器 |
| 切换 `Plan`/`Default` 协作模式 | 选择 cwd、分支、worktree 或执行环境 |
| 回复问题和处理已支持的命令/文件审批 | Windows 默认关闭图片/文件上传；文字消息不受影响 |

目标信息仍是只读展示：手机端可以看到已有目标的状态、内容和计时，但不能创建、修改、暂停、恢复或清除目标。

首条消息发送时才创建聊天；桌面持有的聊天继续通过桌面 IPC 操作。助手持有的聊天由独立 app-server 运行，遇到 active writer 冲突会拒绝恢复。桌面新任务通过列表变化通知触发手机刷新。macOS 与 H5 已完成自动化回归及专用聊天实测；审批链路在隔离 app-server 和模拟模型下验证，多人长期负载仍需补验，手机视口模拟不等同于真实 iPhone 验收。

完整能力矩阵和实现边界见 [手机端与 Codex 能力对照](docs/CODEX-CAPABILITIES.md)。

## 桌面端功能

- Windows 10/11 宿主、便携包、ZIP 和 NSIS 安装器
- macOS 原生窗口和 `.app` 构建脚本
- macOS 菜单栏检查更新与签名更新包验证（首次需手动安装支持更新的版本）
- Windows 托盘检查更新、签名清单、SHA-256 校验、静默安装与重启
- WebView2 与 WKWebView 本地面板
- 关闭到托盘、单实例运行和再次启动唤回窗口
- 配对凭据私有目录、POSIX 权限或 Windows 用户 ACL

## 项目结构

```text
src/
  common/       跨平台路径与文件边界工具
  desktop/      Codex IPC、会话、任务列表、历史与视图投影
  media/        图片、文件、上传和内容校验
  pairing/      配对协议、凭据和本地面板
  transport/    WebSocket 传输、流控和快照分块
  runtime.mjs   桌面端后台入口
public/         本机配对面板和 H5 前端资源
test/           Node.js 单元与协议测试
macos/          Swift 宿主、原生辅助程序和 macOS 构建脚本
windows/        WinForms/WebView2 宿主、图标工具和 Windows 构建脚本
docs/           架构、安全说明与安装示意图
```

## 开始开发

要求 Node.js 22.17 或更高版本。

```powershell
npm ci
npm test
```

运行测试会启动命名管道或本地 socket 测试；不会写入真实 Codex 任务。

## Windows 构建

Windows 构建需要 `.NET 8 SDK`。安装器打包还需要 NSIS；构建脚本会优先使用项目内 `.tools/dotnet` 和 `.tools/nsis`，也可使用系统安装版本。发布构建还需要 Windows 更新签名私钥，格式和发布顺序见 [Windows 自动更新](windows/windows-updates.md)。

```powershell
npm run build:windows
```

输出目录：

```text
build/windows/
  dist/
    codex-phone-assistant.exe
  codex-phone-assistant-windows-x64.zip
  codex-phone-assistant-windows-x64-setup.exe
```

平台细节、安装、首次配对和卸载步骤见 [Windows 安装与使用](windows/README.md)。

## macOS 构建

需要 macOS、Xcode 命令行工具和 Node.js 22：

```sh
npm ci
npm run build:macos
```

默认输出为 `build/codex手机助手.app`。Apple Silicon 包使用本地 ad-hoc 签名。下载、未公证提示处理、配对和常见问题见 [macOS 安装与使用](macos/README.md)。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HUB_ORIGIN` | `https://codex.air-inc.top` | 远程中转和 H5 服务地址 |
| `HUB_IMAGE_PREVIEW` | macOS 为 `1`，Windows 为 `0` | 是否启用本机图片/媒体预览 |
| `HUB_IMAGE_UPLOAD` | macOS 为 `1`，Windows 为 `0` | 是否启用手机图片上传 |
| `CODEX_PHONE_NODE_BINARY` | 留空时下载官方 Node 22.17.1 | Mac 构建时复用本机 macOS Node 22.17+ 可执行文件 |

Windows 图片能力默认关闭；文字配对、历史、发送和停止不依赖这些媒体功能。

## 安全边界

- 本机管理面板只监听 `127.0.0.1`，并校验 Host、Origin、Cookie 和请求体。
- 桌面端只连接配置的 HTTPS/WSS 中转，不提供任意代理。
- 配对凭据保存在当前用户目录；Windows 使用独立 ACL。
- 不提交 `.codex` 会话、配对凭据、日志、构建产物或安装目录。

详见 [能力对照](docs/CODEX-CAPABILITIES.md)、[docs/SECURITY.md](docs/SECURITY.md) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 已知限制

- 部分聊天冷连接较慢；长会话切换耗时有波动，持续连接和进一步提速留到下一期。
- H5 暂不显示未读蓝点。跨端已读同步留到下一期，电脑端蓝点仍按桌面行为显示。
- 助手持有写入权时，桌面主动接管及归档仍有限制；礼品卡聊天的旧恢复锁仍保留，均留到下一期处理。
- 部分历史图片只能显示数量，无法预览。多人长期负载和实际手机键盘、安全区等场景尚未完成验证。

版本变更、测试证据与覆盖边界见 [stable48 验收记录](docs/stable48-release-notes-2026-11-09.md) 和 [历史验收记录](docs/stable41-acceptance-report-2026-11-09.md)。中转配置见 [运行中转服务](docs/RELAY.md)；历史快照不作为当前启动入口。仓库不授予再分发许可，公开或商业发布前仍需确定许可证、检查图标与第三方依赖授权。
