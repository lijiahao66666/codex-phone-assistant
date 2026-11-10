# Windows 自动更新

> 下方“当前稳定源”和旧版安装流程记录既有 0.3.50 行为。源码中下一版保留默认启用的自动检查与手动检查，读取签名版本清单；用户确认后打开 `https://codex.air-inc.top/download/`，手动选择渠道下载安装，不自动下载、退出或安装。新清单尚需部署、签名并验证后才能发布新客户端。

Windows 更新链独立于 macOS Sparkle。修改 Windows 版本、签名或发布文件不得改动 `macos/`、`appcast.xml` 或 Sparkle 密钥。

## 客户端行为

- 版本信息来自程序集 `AssemblyVersion` 和 `AssemblyMetadata` 中的构建号。
- 启动 8 秒后检查一次稳定通道；自动检查默认开启，之后每 6 小时检查。
- 托盘菜单可手动检查，也可关闭自动检查。
- 检查更新只读取 HTTPS 清单，不自动下载。
- 发现更高构建号后显示确认框；用户确认后才下载。
- 清单必须带有与程序内置公钥匹配的 ECDSA P-256 / SHA-256 签名。
- 安装包必须匹配清单中的精确字节数和 SHA-256。清单可提供 `signerThumbprint`，配置后还会校验 Authenticode 签名者证书指纹。
- NSIS 安装版通过独立更新助手完成退出等待、静默安装和重启；便携版只下载和校验。
- 失败日志位于 `%LOCALAPPDATA%\codex-phone-assistant\Updates\update.log`。

## 固定更新地址

下一版客户端使用独立的 `https://codex.air-inc.top/download/windows/latest-manual.json` 和 `.sig`，内容只包含 `schemaVersion: 2`、`channel`、`version`、`build` 和 `publishedAt`。固定下载页地址内置于应用，不由清单指定。旧版仍使用下面的 schema 1 地址和安装包，迁移时必须保持这些资源可用；新客户端须先由用户手动安装一次。

当前稳定源：

- 清单：<https://codex.air-inc.top/download/windows/latest.json>
- 清单签名：<https://codex.air-inc.top/download/windows/latest.json.sig>
- 安装包：<https://codex.air-inc.top/download/windows/codex-phone-assistant-windows-x64-setup.exe>

清单和签名必须是同一批字节。上传后不能重新格式化清单，否则签名会失效。

GitHub Release 中的 Windows 文件只作为手动下载镜像；由于仓库当前为私有，客户端不能把 GitHub Release 直接当作匿名更新源。生产更新仍使用上述公开 HTTPS 路径。

2026-11-10 已从公网下载完整安装包并核对大小 `128687994` 字节、SHA-256 `e0a3b61b7e8fb111071cdaded6e3ff070728cd562a62f32f8fc7a964f21e5b49`；公网 `latest.json` 的 ECDSA 签名验证通过。本次本机完整下载耗时约 279 秒，约 462 KB/s。

## 发布版本

先更新 [version.json](version.json)，至少修改 `version` 和 `build`。构建号必须严格递增；版本说明 URL、更新源和安装包 URL 也在同一文件中维护。不要复用旧构建号发布不同字节。

发布私钥使用 PKCS#8 ECDSA P-256 文件，不得提交到仓库、放入安装包或上传到下载服务器。构建脚本依次读取：

1. `CODEX_PHONE_WINDOWS_UPDATE_PRIVATE_KEY`
2. `%USERPROFILE%\.codex\secrets\codex-phone-windows-update-ecdsa.pk8`

然后运行：

```powershell
npm ci
npm test
npm run build:windows
```

输出：

- `build/windows/codex-phone-assistant-windows-x64-setup.exe`
- `build/windows/codex-phone-assistant-windows-x64.zip`
- `build/windows/latest-manual.json`
- `build/windows/latest-manual.json.sig`
- `build/windows/SHA256SUMS.txt`

构建脚本不会在签名失败或不匹配时继续产出可发布清单。

## 发布顺序

1. 先备份服务器现有 `latest.json`、`latest.json.sig`、安装包和校验文件。
2. 上传新版安装包和 ZIP 到唯一版本路径，或在核对旧文件后原子替换固定路径。
3. 从公网下载安装包，核对大小和 SHA-256。
4. 最后同批上传 `latest.json.sig` 和 `latest.json`；先上传签名，再原子替换清单。
5. 用客户端“检查更新…”验证签名、版本号、下载和安装。
6. 保留上一版安装包，至少完成一次可回滚的手动安装验证。

不要在清单仍指向旧安装包时发布新签名，也不要在安装包未核验时提前替换清单。

## 测试

构建会自动运行两项 Windows 更新测试：

- C# 更新服务自测：签名接受/拒绝、版本门槛、下载、SHA-256 错误拒绝。
- 更新助手实装测试：等待父进程退出、复查哈希、运行静默安装器、重新启动应用。

仍需在真实 Windows 用户目录完成一次跨版本升级，验证用户数据、配对凭据、Node 子进程退出和失败回退。模拟测试不能替代生产 HTTPS 和真实旧包升级。
