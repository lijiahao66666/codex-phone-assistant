# H5 连接耗时诊断

本诊断关联一次任务选择、relay SSE 和本机 connector，不改变原有 debounce、重连、flow 或分片 ACK。旧 H5 忽略新增响应头，旧 relay 没有响应头时页面仍记录本地耗时。

页面控制台执行 `connectionDiagnosticsSnapshot()` 可读取最近 32 次尝试的副本。记录只在当前页面内存中保存，不写入本地存储，也不上传；刷新即清除。每次自动重连有独立的匿名 attempt。实际任务 click 回调入口是选择尝试的单调时钟起点，包含之后的界面处理和 220 ms debounce。`startedAt` 是该记录建立时的 UTC 时间，用来查找日志。

| 页面 milestone | 含义 |
| --- | --- |
| selected / debounce / connect / fetch | 建立选择记录、进入 debounce、开始连接函数、开始 SSE fetch |
| headers / first-bytes | 收到响应头、首次收到非空字节（可能是状态或心跳） |
| chunk-begin / chunk-end | 收到分片 begin、完整快照通过 assembler 校验 |
| first-state / handle-start / handle-end | 收到完整 state 事件、进入处理函数、校验与同步界面处理成功返回；普通 state 的 payload 校验在处理函数中 |
| connected | 成功处理 live state 后页面进入 ready 状态 |
| input-enabled | 输入框首次可编辑；历史草拟也可能触发，不能用作 live 连接成功的证据 |
| closed | 取消、被后续选择替换、断连、格式错误或明确 stream-error；结束后忽略晚到回调 |

`x-codex-stream-id` 响应头复用 relay 已有随机请求 UUID。它同时出现在 relay 的 `stream-timing` 日志和本机 `~/.codex-phone/bridge.log` 的 `stream timing` 记录中。未使用新的请求头或遥测接口，也不记录 thread/device/host ID、标题、路径、消息、payload 或原始错误。

后端每条 stream 每个固定 stage 最多一条，总计不超过 9 条：open、first-ready、first-encoded、first-received、first-written、first-drain、chunk-begin、chunk-end、closed。只保留 streamId、stage、进程内 elapsedMs，以及允许的 bytes/projectMs/encodeMs/queuedBytes/chunked 数值或布尔字段。closed 后不再写入记录。

connector 的 first-ready 表示会话首次给出 ready，first-encoded 表示首次状态编码完成；projectMs 和 encodeMs 分别测量投影与 JSON 编码。分片 chunk-end 表示该次传输 ACK 完成。relay 的 first-received / first-written 表示首次 state 或分片 begin 到达 / 调用下游 write，chunk-end 表示收到该次分片 end；first-drain 仅在首次写入被反压时记录，启用 gzip 时指 gzip 输出流的 drain，不能解释为浏览器完成接收。

各端 elapsedMs 仅在各自进程内比较。UTC 用来定位相邻记录，不能直接相减声称跨主机网络耗时。connector 编码到 relay 收到之间包含发送调度及 WebSocket 传输，当前记录不能继续区分。页面 handle-end 测到同步界面处理返回，浏览器后续 paint 不在范围内。预览或历史消息不会产生 connected 记录。

验证命令：

```sh
node --test test/stream-diagnostics.test.mjs test/stream-diagnostics-ui.test.mjs test/stream-diagnostics-transport.test.mjs test/history-auto-recovery-ui.test.mjs test/stream-window.test.mjs test/pairing-recovery-connector.test.mjs test/relay-server.test.mjs
```

transport 测试使用隔离的临时 bridge 日志、内存 relay 和 mock DesktopSession，覆盖旧版普通 state、现代 state、超过 8 MiB 的分片及关闭后的晚到状态；不连接真实聊天。
