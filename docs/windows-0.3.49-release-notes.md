# Windows 0.3.49 版本说明

记录日期：2026-11-10。版本 `0.3.49`（stable48，构建号 49），面向 Windows 10/11 x64。

## 本版变化

- Windows 加入应用内更新：托盘手动检查、默认开启的周期检查、用户确认、下载进度、退出等待、静默安装和重启。
- 更新清单使用 ECDSA P-256 / SHA-256 分离签名，公钥固定在应用中；安装包校验精确大小和 SHA-256。
- 安装器写入 `DisplayVersion`、发布者、显示图标和版本资源；主程序固定使用 `0.3.49.0` 文件版本和构建元数据。
- 修复 Windows 上传目录被 POSIX 权限位误判为不安全的问题。
- 修复恢复执行检查硬编码 `/bin/ps`、导致 Windows 无法识别子进程启动时间的问题。
- 修正 Windows 路径相关的桌面 IPC、历史游标和图片引用测试夹具。
- 更新 Windows 能力说明：新建聊天、恢复、模型和推理强度已由当前 runtime 实现；目标、插件、应用、cwd、分支、worktree 和完整任务管理仍未接入。

## 验证结果

- 从干净的 `npm ci` 安装成功，npm audit 为 0 vulnerabilities。
- `npm test`：465 项，459 通过、0 失败、6 跳过；跳过项需要显式设置隔离 Codex CLI 测试二进制。
- Windows 更新服务自测通过：签名接受/拒绝、版本门槛、本地下载和错误 SHA-256 拒绝。
- 更新助手实装测试通过：等待父进程退出、再次校验 SHA-256、运行静默安装器并重启应用。
- 安装器构建成功，文件版本为 `0.3.49`；主程序文件版本为 `0.3.49.0`。
- macOS 文件未修改，Sparkle 配置、构建脚本和更新密钥未改动。

## 仍需实机验证

Windows 安装包、ZIP、校验文件和签名清单已附加到 GitHub `stable48` Release，并已发布到公网固定更新目录。以下文件均通过 HTTPS 返回 200，完整安装包下载后的大小和 SHA-256 与清单一致，`latest.json` 签名验证通过：

- `latest.json`
- `latest.json.sig`
- `codex-phone-assistant-windows-x64-setup.exe`
- `codex-phone-assistant-windows-x64.zip`
- `SHA256SUMS.txt`

本次从公网完整下载 128,687,994 字节安装包耗时约 279 秒。尚未在第二台真实 Windows 电脑上完成“旧安装版通过生产 HTTPS 更新到新安装版”的完整升级。

当前安装器和主程序没有 Authenticode 商业证书签名；更新清单签名和 SHA-256 用于验证更新内容，但不能替代 Windows SmartScreen 的发布者信誉。首次安装支持更新的版本必须手动完成。GitHub 仓库为私有，Release 附件是手动下载镜像，不能作为客户端匿名更新源。
