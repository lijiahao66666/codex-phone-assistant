# codex手机助手：源码草稿

本目录是待审查的源码快照，尚未公开发布，也尚未选定开源许可证。它包含 Mac 助手连接器和本机配对界面，运行时以 2026-11-06 的 Mac 测试包为基线。它不是 OpenAI 官方产品；桌面通信依赖未公开、可能随版本变化的 IPC 协议。

当前快照不包含已部署的中转服务或与其配套的线上 H5 版本，因此不能独立部署出完整服务。默认中转地址指向现有服务，`HUB_ORIGIN` 可在启动时覆盖；公开发布前需要明确服务地址及运行方式。连接器会使用当前用户的 Codex 数据和配对凭据，请勿把真实配对文件、会话和日志提交到仓库。

## Mac 构建

需要 macOS、Xcode 命令行工具、Node.js 22（`node:sqlite`）和 npm。安装依赖后运行：

```sh
npm ci
MACOSX_DEPLOYMENT_TARGET=12.0 ./mac-app/build.sh
```

构建脚本从 Node.js 官方站点下载运行时并校验 SHA-256；输出路径默认是 `build/codex手机助手.app`。需要可联网下载。脚本不会为应用进行 Apple Developer ID 签名或公证。安装包、真实配对、旧版 macOS 和 Intel Mac 尚未在此快照中完整验证。

执行随附的定向单元测试：

```sh
node --test approval-guard.test.mjs async-question-guard.test.mjs conversation-state.test.mjs desktop-view.test.mjs thread-list.test.mjs
```

## 公开前待处理

- 用户确定项目许可证；检查所有第三方依赖的许可证、版权声明以及分发义务。
- `mac-app/chatgpt-icon.png` 和生成图标包含 OpenAI 图形标志；确认使用及再分发权限，或替换为自有图标。
- 整理并验证中转服务与线上 H5 的准确版本，形成可复现部署文档；梳理身份认证、数据访问、传输及安全边界。
- 清点默认域名、应用名称、构建标识和示例中涉及的个人或服务信息，确认是否保留。
- 补齐 Mac 安装、配对、消息和停止的真实端到端验证；Windows 适配与测试尚未合入本快照。
- 开源前再次执行秘密扫描、个人信息检查和人工代码审查，确认历史记录及所有资源适合公开。

本目录不含许可证文件，并不授予第三方使用或再分发许可。

## Windows 开发候选

`windows-candidate/` 是原生窗口和安装器的独立实验，`windows-compat/` 是路径兼容补丁候选。两者尚未合入产品运行时，不能直接作为可用安装包。请先阅读各目录 README；Windows 端仍需实现和验证 IPC、凭据 ACL、配对、媒体处理和安装卸载。不要用真实任务验证写操作，优先使用专用测试聊天。
