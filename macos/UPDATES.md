# macOS 更新与发布

应用默认自动检查更新，也可在窗口或菜单栏手动检查。发现新版本时，用户可以打开下载页，自行下载安装；应用不会自动下载安装包。

## 版本信息

客户端使用 Sparkle 验证 `https://codex.air-inc.top/download/appcast.xml`。正式版本使用签名的信息型条目，包含版本号、递增的构建号和下载页链接，不包含安装包。不要修改签名后的 appcast。

信息型条目已在隔离测试应用中验证：有效签名可识别下载页，篡改后验证失败；生产环境的标准更新提示及打开下载页流程仍需实机复验。

## 构建与发布

1. 使用正式 HTTPS 更新地址及现有 Ed25519 公钥配置构建；发布私钥保存在受保护的签名环境，不提交到仓库或上传服务器。构建号必须高于已发布版本。
2. 构建并验证安装包，将其放到 GitHub 发行版及其他下载渠道。
3. 使用现有私钥签名不含 `enclosure` 的信息型 appcast，核对签名、版本号、构建号和下载页地址后发布。
4. 用旧版客户端验证更新提示、打开下载页及手动安装。安装时如助手正在运行，应先正常退出。

```sh
python3 macos/test-update-build-config.py
swiftc macos/UpdateConfiguration.swift macos/UpdateConfigurationTests.swift -o /tmp/codex-update-config-tests
/tmp/codex-update-config-tests
```

应用使用 ad-hoc 签名，未经过 Apple 公证。首次打开可能出现系统安全提示，操作步骤见 [macOS 安装说明](README.md)。
