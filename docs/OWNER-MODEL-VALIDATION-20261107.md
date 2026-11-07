# 新聊天、历史恢复与模型选择验收记录

分支：`codex/phone-owner-model-20261106`。基线：`2065f77`。本记录截至 2026-11-07，仅记录本轮当前源码实测；不代表已发布到公网。

## 已验证

- `npm test`：78 项通过，无失败、跳过或取消。日志保存在 `../codex-phone-owner-model-validation-20261107/tests.log`。
- 真实隔离 Codex CLI、临时数据目录、IPC 和本地 relay：创建聊天、模型与强度切换、发送、助手退出、历史恢复和重连读消息。模型输出由 loopback 服务模拟。
- 生产模型确认逻辑：独立 fresh IPC observer 确认状态后解锁并关闭；所选模型及强度在 owner 退出恢复后保留。
- 运行中的助手任务拒绝普通退出，原任务继续；恢复期间拒绝重复恢复，结果未知时不自动重发。
- 列表变化：只读 SQLite `data_version` 与项目文件变化通知经 connector、relay SSE 到达 H5；变化检测不查询完整列表。
- ego 空间 66 浏览器点击：项目选择、新建首条消息、模型选择、high 强度、发送后输入框清空、用户消息与回复同时可见。
- 浏览器历史聊天：初次显示已保存历史，点击“继续聊天”后接入实时状态，可再次发送并看到用户消息及回复。
- 浏览器列表：保持已有聊天打开，在本机侧创建测试任务，H5 侧栏自动出现新任务。
- 当前源码真实桌面专用聊天 `01a1b198-4416-7c42-91f6-7c3eebfcfe30`：创建并收到回复，fresh observer 将强度切到 low 并确认；恢复原强度后助手正常退出，另一 OwnerRuntime 恢复历史，再通过 DesktopSession 发送并收到回复。测试进程已退出，未操作用户当前聊天或配对。
- Apple Silicon Mac 包：关键资源与源码 SHA-256 一致；Node 22.17.1 可导入核心模块；Info.plist 和 ad-hoc 签名严格校验通过；ZIP 解压后签名仍有效。

## 本轮修复

初始用户消息实际在 `turn.params.input`，投影现补回这条消息并保留后续追加输入；首个对应回声不重复显示。结构化图片走同一媒体授权校验。真实数据中不同 message id 的相同文字会保留，不按文字删除。

H5 改为读取投影实际提供的 `model` 和 `reasoningEffort`，增量更新也保留这两个字段。初次进入主页先读取设备身份再加载模型目录；当前模型不在可选目录时，仍可选择目录中的其他模型。

新增 `thread-list-changed` 通知，H5 在独立侧栏连接和当前聊天连接中均接收，并合并短时间连续通知后刷新列表。

Mac 构建脚本补入显式 ad-hoc 签名和严格校验步骤。包放在临时 `.noindex` 目录，未增加应用程序目录中的测试副本。

## 产物与证据

- App：`/private/tmp/codex-phone-owner-model-final-20261106-235529.noindex/codex手机助手.app`
- ZIP：同目录 `codex-phone-assistant-macos-arm64.zip`
- ZIP SHA-256：`44e49188d594a3d67bc26c45e8d0b3988e6f9ac48ee30ef41f0de51b3e594229`
- 浏览器截图、测试日志与真实专用聊天证据：`../codex-phone-owner-model-validation-20261107/`。
- ego 空间 66 为本任务专用；空间 49 留给另一个任务。

## 仍待完成

当前线上仍运行旧版中转与 H5；运行中的手机助手也是上传修复版本。本轮未替换它们。另一个任务正在修改线上上传链路，需要合并最终源码后发布，避免覆盖它的修复。

公网安装替换、保持既有配对、真实 H5 新建与桌面交接，以及 iPhone 真机验收尚未完成。用户已允许先用浏览器验收，真机兼容性不能据此记为通过。

本地浏览器 fixture 曾一次收到 CLI `list_turns is not supported yet`，进程明确退出后重跑成功；真实专用线程读取及完整测试未复现。目前没有改 CLI 或添加猜测性回退。

真实专用线程首轮耗时超过最初测试等待时间，并产生四条内容相同但 id 不同的助手消息。原 rollout 在模型切换前已存有这四条，H5 投影没有制造重复；记录中没有足够证据认定上游原因。


## 上传修复组合验证

2026-11-07 后续核对确认，另一任务已在公网发布 gzip 分片传输和失败诊断。当前分支已整合该已发布 H5 补丁，并在新聊天附件流程采用同一协商协议；保留本仓库的 `/state-chunks.mjs` 模块路径，不沿用旧部署别名。源 H5 SHA-256 为 `aa08a92d231a95a76466bab0cdf8c553c0ba06cf0479f06a1d169baa50711368`。

同时整合 H5 worktree 中的上传空闲超时续期和历史活动投影。源 worktree 保持只读，没有整体复制其尚未发布的附件菜单和文件缩略图改动。当前 owner、模型服务、项目选择、实时列表通知和配对逻辑均保留。

组合后的完整测试为 88 项通过，日志为 `combined-tests.log`。随后补入线上已有的三处上传失败诊断，定向 relay 与压缩测试另存 `relay-combined-tests.log`。诊断仅记录阶段、字节数、状态、耗时及拒绝来源。

ego 空间 66 随后从空间列表消失；调用返回 `task space not found: 66`，现存列表为 22、24、49。已按技能要求询问是否新建本任务专用空间，未争用 49。组合版本的浏览器验收和发布尚未完成，不能用前一轮浏览器结果替代。


组合 Mac 包位于 `/private/tmp/codex-phone-owner-model-final-20261107-022248.noindex/`，包含 `codex手机助手.app`、`codex-phone-assistant-macos-arm64.zip` 和源校验清单。ZIP SHA-256 为 `43197eea5325f08a0226a9d2c0ba5954b7f187fb483a5544765f675ada8fdee1`。60 个源文件与包内容一致，解压后签名校验通过。没有启动或替换用户软件。

组合中转候选 `relay-combined-candidate.tar.gz`、源清单 `combined-source-manifest.json` 保存在本任务证据目录。候选 SHA-256 为 `21751db2a407ee9ecc2b56b99e110f380faff01ee96255aba7e1a0e1c7cc7578`。本轮验证结束后已向确认属于本任务的隔离浏览器 fixture 进程发送 SIGTERM；未停止用户桌面 Codex 或手机助手。


补充发布回归：新增真实持久化 SQLite 中转重启用例。先注册电脑并通过二维码配对，再关闭中转，以同一数据库重新启动；原手机 Cookie 仍返回同一个 device id，未增加配对记录；原电脑 secret 可重新建立 connector，手机 host-status 为 online。`test/relay-server.test.mjs` 的 3 项测试通过，日志为 `pairing-restart-tests.log`。测试用临时身份，不接触真实手机凭据。该补充只修改测试，当前 Mac 产物与运行源码仍一致。测试请求显式关闭 HTTP 连接，避免复用前一个服务进程已关闭的 Node fetch keep-alive socket。


## 最新线上附件界面与云端暂存

已根据用户之前“换一个空间”的明确授权创建专用 ego 空间 67。组合版本再次合入线上 JS `8382c0bf97ea344eb48de1b99e31a32afc5d1079b9723027dc926946d15536c8` 的统一附件选择、文件缩略图和独立计划模式行，保留新聊天与模型控件。PDF 依赖固定为 `pdfjs-dist 6.4.299`，生产中转接入固定资源路径与 worker CSP。

`release-tests.log` 为本次完整测试：101 项通过、无失败或跳过。空间 67 真实浏览器点击已验证新聊天、high→medium 强度切换、历史恢复后发送；本机创建任务到 H5 列表出现测得约 262 ms。375 px 截图为 `release-new-chat-mobile.png` 和 `combined-history-mobile.png`，实际回复与用户首条消息均可见。

发布暂存包 `deploy-release.tar.gz` SHA-256 为 `bba9aeb2665a4eb95fc01d407d8c7b9db1ce484d9d0fd27ddbef96fd8deac1c0`，已上传并验 hash。云端暂存目录 `/opt/codex-hub-paired/owner-model-20261107-stage`，未替换正式入口。用正式配对数据库的 SQLite 只读快照在独立端口 18789 冒烟验证，7 个静态资源正常；2 个 host、12 个 device 记录保持一致，暂存进程已退出。回执在暂存目录 `smoke-receipt.json`。

线上正式服务仍为原 `codex-hub-paired.service`，使用 `/var/lib/codex-hub-paired/pairing.sqlite`、端口 8789 和原 managed wrapper。云端 registry SHA-256 与当前仓库相同。已准备切换脚本，在检查线上基线 hash、暂存 hash 和烟测回执后备份入口/静态文件及数据库；只替换入口转发与相关静态文件，保留 systemd、配对数据库和 managed wrapper。脚本尚未执行。

最新 Mac 包仍在原 `.noindex` 目录，ZIP SHA-256 更新为 `01834c4f7b5fcafb00f392f6c4fcd1a5bfd1534ff66c6e7ec6ef4779c29b1f4c`。616 个源码及 PDF 依赖文件与源一致，解压后签名校验通过。旧包保留备份。

云端暂存烟测成功后，空间 67 返回“task has ended”，已停止浏览器操作并请求恢复同一空间。没有切换正式服务，没有替换本机运行中的上传修复版助手。
