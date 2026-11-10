# macOS 应用内更新

应用集成官方 Sparkle 2.10.1，提供菜单栏中的“检查更新…”和“自动检查更新”。自动检查默认开启；下载安装需要用户确认，不启用静默自动安装。更新界面和签名验证由 Sparkle 提供。

更新安装通过 macOS 正常退出事件请求退出助手。助手持有的任务运行中、存在未确认写入或无法确认其状态时，以及正在转发操作或处理附件时，runtime 会阻止退出。Sparkle 等待助手进程真正退出后才替换应用，不应额外强退助手或 Codex。本机发送队列排空不代表手机已收到回执，断线时结果仍可能未知。

## 发布配置

首次包含更新能力的版本需要手动安装。正式更新配置必须同时提供 HTTPS appcast URL 和可信 Ed25519 公钥。缺少其中任意一项会使构建失败；两项都不提供时构建可用于本地开发，但菜单显示“检查更新（未配置）”，不进行更新网络请求。

使用官方 Sparkle 包中的 `bin/generate_keys` 创建发布密钥。私钥保留在钥匙串或专用发布签名环境，不能提交到仓库、放入应用或上传下载服务器。将其输出的公钥填入构建配置。不要为每次构建重新生成密钥，否则旧版本无法验证后续更新。

```sh
CODEX_PHONE_APP_VERSION=0.3.0 \
CODEX_PHONE_BUILD_VERSION=49 \
CODEX_PHONE_PREVIOUS_BUILD_VERSION=48 \
CODEX_PHONE_UPDATE_FEED_URL='https://codex.air-inc.top/download/appcast.xml' \
CODEX_PHONE_UPDATE_PUBLIC_KEY='填写正式发布公钥' \
sh macos/build.sh '/tmp/codex手机助手.app'
```

构建号为正整数，必须大于声明的上一发布构建号。发布者需要把 `CODEX_PHONE_PREVIOUS_BUILD_VERSION` 设为真实线上版本；本地验证不能代替线上版本检查。开发默认值为 `0.2.0 / 3`，上一版本为 `2`。

构建下载固定官方包，并校验其 SHA-256。可通过 `CODEX_PHONE_SPARKLE_ARCHIVE` 指定已下载的官方归档，仍执行相同校验，不使用其他应用内的框架。原生构建需要 Python 3 校验配置。

使用同一官方包中的 `bin/generate_appcast --account codex-phone-assistant` 为最终 ZIP 和 appcast 签名；用 `ditto -c -k --sequesterRsrc --keepParent` 创建更新 ZIP。应用要求提取前验证更新包，且必须验证 appcast 签名；签名失败不设置过期降级。工具会识别应用中的签名要求，并自动签名 appcast 及外部版本说明。appcast 的 `sparkle:version` 必须匹配 `CFBundleVersion`，并包含正确的文件大小、HTTPS 下载 URL 和 EdDSA 签名。先上传并核验 ZIP，再发布 appcast；不能签名后修改 ZIP、appcast 或版本说明。DMG 继续用于手动安装。

## 本地检查

```sh
python3 macos/test-update-build-config.py
swiftc macos/UpdateConfiguration.swift macos/UpdateConfigurationTests.swift -o /tmp/codex-update-config-tests
/tmp/codex-update-config-tests
```

隔离实装测试需要 Python `cryptography` 和已通过官方摘要校验的 Sparkle 2.10.1 解包目录：

```sh
CODEX_PHONE_SPARKLE_DIST='/tmp/codex-sparkle-2.10.1-read' python3 macos/test-updater-integration.py
```

测试使用独立 bundle ID、临时安装位置、仅驻留内存的临时 Ed25519 密钥、回环 HTTP 服务及测试包专用 ATS 例外，不修改系统或用户证书信任。测试包用无 owner 的 stub runtime 模拟 `STOP_BLOCKED`，并用测试 user driver 自动确认操作；原生退出保护代码保持原样，只有 UI 展示被隐藏。测试不会启动真实 Codex owner，不会替换当前安装，结束后清除测试偏好与缓存并保留日志。

2026-11-09 在 Apple Silicon 实测通过：正确签名 ZIP 从 build 1 安装到 build 2 并重新启动；错误密钥签名被 Sparkle 以 4005/3002 拒绝，旧应用仍可运行；退出保护拒绝退出后旧应用保持 build 1，解除保护并重试后才替换并启动 build 2。另有 7 组构建配置检查、原生配置检查和 23 项既有 runtime/owner 相关回归通过。

这些结果验证了真实 Sparkle 安装与原生退出握手，不等同于真实 Codex 任务的端到端升级验收。生产 HTTPS、标准更新 UI、签名缺失、下载中断、低版本、只读安装位置及下载后的 Gatekeeper 行为仍需单独验证。不得用正在执行用户任务的 Codex 来做退出实验。

当前应用本身仍使用 ad-hoc 签名，没有 Apple Developer ID 和公证。EdDSA 验证发布更新的来源，不能替代 Apple Gatekeeper 信任；不能保证下载后没有系统提示。Sparkle 处理更新安装，不代表已实现运行异常后的业务健康检查和自动回退。

官方接口依据：[程序化接入](https://sparkle-project.org/documentation/programmatic-setup/)、[更新设置](https://sparkle-project.org/documentation/customization/)、[安全与签名](https://sparkle-project.org/documentation/)。
