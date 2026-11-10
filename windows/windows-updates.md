# Windows 自动更新

> 已发布的 0.3.51 不配置更新源。源码中下一版保留默认启用的自动检查与手动检查，读取签名版本清单；用户确认后打开 `https://codex.air-inc.top/download/`，手动选择渠道下载安装，不自动下载、退出或安装。新清单尚需部署、签名并验证后才能发布新客户端。

Windows 更新链独立于 macOS Sparkle。修改 Windows 版本、签名或发布文件不得改动 `macos/`、`appcast.xml` 或 Sparkle 密钥。

## 客户端行为

- 版本信息来自程序集 `AssemblyVersion` 和 `AssemblyMetadata` 中的构建号。
- 配置更新源后，启动 8 秒检查一次，之后每 6 小时检查。
- 托盘菜单可手动检查，也可关闭自动检查。
- 检查更新只读取 HTTPS 清单，不自动下载。
- 发现更高构建号后显示确认框；用户确认后打开下载页。
- 清单必须带有与程序内置公钥匹配的 ECDSA P-256 / SHA-256 签名。
- 下载与安装由用户自行执行；新客户端不会自动下载或运行安装包。

## 当前更新地址

Windows `0.3.51` 默认不配置更新源。因轻量服务器带宽不足，`https://codex.air-inc.top/download/windows/` 下的安装包、ZIP 和更新清单已经撤除。

下一版客户端计划使用独立的 `https://codex.air-inc.top/download/windows/latest-manual.json` 和 `.sig`，内容只包含 `schemaVersion: 2`、`channel`、`version`、`build` 和 `publishedAt`。固定下载页地址内置于应用，不由清单指定。新客户端须先由用户手动安装一次。

清单和签名必须是同一批字节。上传后不能重新格式化清单，否则签名会失效。

GitHub Release 中的 Windows 文件只作为手动下载入口；仓库当前为私有，下载需要授权。版本检查只需公开的签名清单，不需要托管安装包。

## 发布版本

先更新 [version.json](version.json)，至少修改 `version` 和 `build`。构建号必须严格递增。`updateFeedUrl` 为空时不生成更新清单；配置 HTTPS 地址后生成签名版本信息。

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

1. 准备并验证安装包及用户可访问的下载渠道。
2. 备份旧清单；将签名与清单按发布流程更新，检查公网返回的字节和签名。
3. 用客户端检查新版本，验证打开下载页和手动安装；旧版至新版首次安装需手动完成。

## 测试

构建会自动运行两项 Windows 更新测试：

- C# 更新服务自测：签名接受/拒绝、版本门槛、下载、SHA-256 错误拒绝。
- 更新助手实装测试：等待父进程退出、复查哈希、运行静默安装器、重新启动应用。

仍需在真实 Windows 用户目录完成一次跨版本升级，验证用户数据、配对凭据、Node 子进程退出和失败回退。模拟测试不能替代生产 HTTPS 和真实旧包升级。
