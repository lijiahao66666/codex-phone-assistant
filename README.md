# Codex 手机助手

在手机上通过 H5 查看和控制本机 Codex 任务的桌面助手。项目由本机桌面端、本机配对面板和远程 H5 组成，使用 Codex Desktop 的本地 IPC 读取任务状态，并沿用桌面端的安全决策。

> 这不是 OpenAI 官方产品。桌面端依赖未公开、可能随 Codex 版本变化的 IPC 协议。

![电脑与手机同时查看同一 Codex 任务](docs/assets/desktop-phone-view.png)

## 已实现

- Windows 10/11 桌面端、便携包、ZIP 和 NSIS 安装器
- macOS 原生窗口和 `.app` 构建脚本
- 本机配对面板、二维码和临时配对码
- 项目与任务列表、历史读取、实时消息和停止任务
- Windows 命名管道与路径兼容
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

Windows 构建需要 `.NET 8 SDK`。安装器打包还需要 NSIS；构建脚本会优先使用项目内 `.tools/dotnet` 和 `.tools/nsis`，也可使用系统安装版本。

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

平台细节、安装、首次配对和卸载步骤见 [windows/README.md](windows/README.md)。

## macOS 构建

需要 macOS、Xcode 命令行工具和 Node.js 22：

```sh
npm ci
npm run build:macos
```

默认输出为 `build/codex手机助手.app`。当前仓库提供构建路径，但本次改动只在 Windows 真机完成了完整 H5 联调；macOS 安装、配对和媒体流程仍需单独验收。详见 [macos/README.md](macos/README.md)。

macOS 下载、未公证提示处理、配对和常见问题见 [macOS 安装与首次打开](macos/README.md)。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HUB_ORIGIN` | `https://codex.air-inc.top` | 远程中转和 H5 服务地址 |
| `HUB_IMAGE_PREVIEW` | macOS 为 `1`，Windows 为 `0` | 是否启用本机图片/媒体预览 |
| `HUB_IMAGE_UPLOAD` | macOS 为 `1`，Windows 为 `0` | 是否启用手机图片上传 |
| `NODE_ARCHIVE_URL` | 官方 Node 22.17.1 地址 | 构建时使用固定版本的镜像 |

Windows 图片能力默认关闭；文字配对、历史、发送和停止不依赖这些媒体功能。

## 安全边界

- 本机管理面板只监听 `127.0.0.1`，并校验 Host、Origin、Cookie 和请求体。
- 桌面端只连接配置的 HTTPS/WSS 中转，不提供任意代理。
- 配对凭据保存在当前用户目录；Windows 使用独立 ACL。
- 不提交 `.codex` 会话、配对凭据、日志、构建产物或安装目录。

详见 [docs/SECURITY.md](docs/SECURITY.md) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 发布状态

Windows 版已完成以下真实验证：

- 52 项自动化测试全部通过
- Windows 命名管道握手、项目与任务读取
- H5 配对、历史、发送与停止
- 关闭到托盘、再次启动唤回
- 安装、卸载和重新安装

仓库不包含线上中转服务和 H5 的部署源码，也不授予再分发许可。公开或商业发布前仍需确定许可证、检查图标与第三方依赖授权，并补充对应服务端版本说明。
