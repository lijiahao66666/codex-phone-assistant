# Windows 路径兼容候选

以 `work/codex-phone-distribution-20261106/mac-current/codex手机助手.app/Contents/Resources/runtime` 为基线，只修改 `desktop-ipc.mjs`、`thread-list.mjs`、`rollout-history.mjs`，新增 `path-utils.mjs`。其余模块为便于本地回归而复制的基线，不应全量覆盖其他工作。

修复消息 cwd 和图片路径的绝对路径判断、项目分组的盘符和 UNC 路径、历史文件目录边界的 Windows 分隔符处理。Windows 使用 `path.win32` 的定向模拟，未在 Windows 真机运行。

`node --test path-utils.test.mjs thread-list.test.mjs rollout-history.test.mjs`：10 项通过。另以正式源码中的较新 `desktop-ipc.test.mjs` 测试旧 Mac 基线，17 项中 15 项通过，非对象帧和 owner 发现期间设置变更两项失败；这是基线与新测试的差异，不应宣称完整回归通过。此候选未实现 Windows 凭据 ACL、媒体预览与上传的安全实现，也未对接 Windows 命名管道。
