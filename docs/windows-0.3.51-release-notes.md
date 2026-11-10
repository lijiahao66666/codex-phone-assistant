# Windows 0.3.51 版本说明

记录日期：2026-11-10。版本 `0.3.51`（构建号 51），面向 Windows 10/11 x64。

## 本版变化

- 安装完成页增加默认勾选的“启动 codex手机助手”，手动安装完成后自动打开应用。
- 保留 0.3.50 的运行中覆盖保护：安装器先通过本地退出事件请求已运行的助手退出，无法退出时在写入文件前停止。
- Windows 安装包改为 GitHub 手动发布，并从轻量服务器移除安装包、ZIP、校验文件、更新清单和签名，避免占用服务器带宽。
- 默认清空 `updateFeedUrl` 和 `installerUrl`。托盘保留更新入口，但显示“未配置”，不会发起周期性网络请求。

## 下载与安全

GitHub Release：

- `codex-phone-assistant-windows-x64-setup.exe`
- `codex-phone-assistant-windows-x64.zip`
- `SHA256SUMS-windows.txt`

安装器没有 Authenticode 商业证书签名，首次从浏览器下载时可能触发 SmartScreen。只应对已核对 SHA-256 的本发布文件选择“更多信息” → “仍要运行”。

## 验证

- 运行中执行本版复装，安装器成功请求助手退出。
- 图形安装完成页默认勾选“启动 codex手机助手”；点击完成后实际启动成功。
- 安装后文件版本为 `0.3.51.0`，主窗口标题为“codex手机助手”。
- 安装包大小 `128688545` 字节，SHA-256 `4edf1709f2d601f872c0ce2118f404f13538b60d46075b55578de7f68bbbd892`。
- macOS、Sparkle 配置和公网 Mac 更新文件未修改。
