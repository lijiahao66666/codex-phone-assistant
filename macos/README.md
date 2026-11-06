# macOS 桌面端

下载和安装说明适用于 Apple 芯片的 Mac，要求 macOS 12 或更新版本。Intel 版暂未提供。

> 安装包尚未经过 Apple 公证。只有在确认来源可信时才继续打开。若无法验证来源，请停止安装。

## 下载

从[项目下载页](https://codex.air-inc.top/download/)获取
`codex-phone-assistant-macos-arm64.dmg`。

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

验证通过后会出现本机配对窗口：

![codex手机助手的手机配对界面](../docs/assets/mac-pair.png)

## 手机配对

1. 确认 Mac 上已登录 Codex 桌面版。
2. 打开 `codex手机助手`，点击“生成配对码”。
3. 在手机浏览器打开 https://codex.air-inc.top/，输入配对码并在电脑上确认。
4. 也可以直接用手机扫描电脑上的二维码。
5. 配对完成后，在手机端选择任务即可查看和操作。

## 本地构建

要求 macOS、Xcode 命令行工具、Node.js 22 和网络连接。

```sh
npm ci
npm run build:macos
```

构建脚本会校验官方 Node 包，默认输出到 `build/codex手机助手.app`。构建结果不会自动签名或公证。

## 状态

构建脚本和运行时入口已迁移到当前目录结构。当前仓库只在 Windows 真机完成完整 H5 联调；macOS 安装包、配对、消息和停止仍需单独验收。
