# stable26 验收证据核对

最新补充（2026-11-08 19:07）：思考等级恢复时另一个字段竞态已修复。`thread/settings/updated` 只确认 model 或 serviceTier 时，不再整条废弃待返回恢复响应中的独立 reasoningEffort；后到的新等级（包括显式 null）仍优先。observer/view/router 定向检查 42/42 PASS，签名通过的 `codex-phone-stable26-effort-partial.noindex` 包已安装，Desktop PID 40360 保留。公网 cli 开放再次显示 `GPT-6.1 Terra · high`、输入可用，证据 `/private/tmp/codex-stable26-effort-partial-cli-live.json`。这仍不保证所有已有 Desktop owner 的 snapshot 都带有有效等级；明确的 null 仍保持原义，不用数据库或历史猜测覆盖。

全列表连接检查尚未完成：24 条列表中执行了 21 条短等待后，发现助手 runtime PID 28169 已退出，主壳仍在；后段超时不能作为每条聊天各自无法连接的证据。原记录保存在 `/private/tmp/codex-stable26-all24-partial-invalidated.json`，已中止该轮并正常重启助手，不能写成全 24 条通过。退出原因尚未由现场日志确认。此前 90 秒采样的原始数据另存 `/private/tmp/codex-stable26-all24-process-samples.json`，该窗口 Desktop RSS 峰值 490.2 MiB、助手 345.2 MiB；这段采样未涵盖后来退出，不能证明进程长期稳定。

本轮后续实测补充（2026-11-08）：

- 登录页面已刷新，实际脚本引用为 `desktop.js?v=20261108-stable26`。
- 真实桌面输入框在专用任务 D 发出 `DESKTOP_TO_H5_OK_20261108_D` 测试请求，H5 收到该用户消息及准确回复；证据 `/private/tmp/codex-stable26-desktop-to-h5.json`。这是原生桌面 Send 按钮操作，不是聊天写入工具。
- 新页面连续切换 D、C、cli 开放、购物金，共 80 次；选中 ID 无错位，任务列表始终保留 25 个按钮，最终购物金恢复 `ready`。其中后 32 次精确监测列表接口 `/api/threads`，最大在途数为 1，记录的响应均为 200；其他聊天接口仍出现过 503，不能扩写为所有请求零错误。证据 `/private/tmp/codex-stable26-live-rapid-80.json`。
- 90 秒进程采样期间 Desktop 与助手 PID 均保留；Desktop RSS 峰值约 1.28 GiB、结束约 282 MiB，助手 runtime 峰值约 1.10 GiB、结束约 323 MiB。大任务切换仍有明显峰值，不能认定内存问题完全解决。证据 `/private/tmp/codex-stable26-live-rapid-process-summary.json`。
- 原生桌面对专用任务 B 点击 Archive 后，SQLite 中 `archived` 仍为 0；此前桌面工具返回 active writer 冲突。原生归档记为 FAIL，删除未继续执行。现有 H5 后端归档入口的退订逻辑不等于原生桌面流程通过。
- 用户反馈等级显示“默认”，已确认购物金和 cli 开放的数据库当前等级为 `high`，但 H5 实时元数据为 `reasoningEffort: null`。恢复响应到同步快照之间丢失等级是独立缺陷，修复与安装后复验另记，不能把当前模型/等级项标为完整 PASS。

思考等级后续修复：本仓库 LocalOwner 适配层消费实际 `thread/start`、`thread/resume` 成功响应中与 thread 并列的 `model`、`reasoningEffort`，在历史 hydrate 后更新本地投影。它不发送 settings 写请求，不以历史 turn 或全局默认替代当前设置；显式 null 保留，并抑制较旧恢复响应覆盖较新已确认设置。定向 owner/view/router 测试 39/39 PASS，相关运行与乐观发送回归 8/8 PASS。新 Mac 包完成签名校验并安装；原助手及子进程正常退出，Codex Desktop 未重启。公网 H5 的购物金已恢复 `reasoningEffort: high`，显示 `GPT-6.1 Terra · high`，输入可用；证据 `/private/tmp/codex-stable26-effort-shopping-live.json`。本项属于电脑同步层修复，服务端静态版本继续为 stable26。

未读问题已确认一个缺口：普通后台 turn 完成未发送 `thread-read-state-changed` 的 true 事件，现有依赖只在读取时广播 false；但后续发送正确协议通知仍未通过实机持久化闭环，不能将此缺口写成完整根因。Desktop 对 IPC snapshot 的接收不等同原生完成时持久化未读。不能仅在 H5 加蓝点绕过桌面权威状态。该缺陷与原生归档 writer 冲突仍是稳定版验收阻塞项，未宣称正式稳定版通过。

第二条真实旧聊天 cli 开放也已连接并显示 `GPT-6.1 Terra · high`，输入可用；证据 `/private/tmp/codex-stable26-effort-cli-live.json`。两条旧聊天均仅打开读取，没有发送新消息或修改模型/等级。

补充公网交互：专用 D 的等级从 low 切 high，再恢复 low，均等到 owner 确认；文本文件与 160×100 PNG 一起发送成功，输入框立即清空，真实模型准确回复验收标识，聊天图片及大图预览均加载到原始 160 像素宽。停止专项在 active 时点击停止，最终 turn 为 interrupted、runtime 为 idle、输入框恢复可用。证据 `/private/tmp/codex-effort-live-write-regression.json`、`/private/tmp/codex-stable-stop-live.json`；附件回复为 `ATTACHMENT_SENT_OK_20261108_D`。

未读候选未通过真实闭环，未发布：候选在 22 项定向测试中通过，包括真实 loopback socket、主 stream reader 生命周期、身份隔离、竞态及排队消息。实际 D 发起 180 行回复后 140 ms 切 C；完成日志证明 owned=true、readers=0、status=completed，已向现有 owner socket 写入 unread=true，真实 ChatGPT 身份和 executionHostKey 与桌面持久化身份匹配；桌面仍未持久化 D 未读，H5 未出现蓝点。socket 写成功不能证明桌面接收，不能将本项写 PASS。候选已通过 Git stash 单独保存，安装恢复到已验证的思考等级修复包 `/private/tmp/codex-phone-stable26-effort-final.noindex/codex手机助手.app`，没有将失败候选留在运行版本。

后续原生归档/删除的条件复验：助手正常重启释放 B 的 writer 后，B 未再由 H5 打开恢复；桌面原生侧栏 `Archive chat` 按钮成功，SQLite `archived=1`，H5 列表随后移除 B。桌面 `delete_thread` 工具再删除这一已归档专用聊天，返回 `deleted=true`，SQLite 行数为 0。结论是 writer 已释放时原生归档 PASS、桌面工具删除 PASS；不能据此覆盖“助手仍持有 writer 时原生归档失败”的已复现限制。没有操作其他用户聊天。

连接探测优化：共享池内 `probeOwner` 改用发出 follow 后收到的当前任务 snapshot 验证 owner、任务 ID 和 revision，省去原来的 `load-complete-history`/完整历史重新 hydrate；隔离 custom socket 保留原验证方式。45 项 IPC/pool/router 定向测试通过，覆盖超时、取消、owner 变更、断线、旧快照不作存活证据和主订阅隔离。已重新构建安装并通过签名校验。对 C 的实机快照探测返回 revision=1，耗时 2 ms，临时消费者归零；公网恢复接口返回 202、295 ms。D/C 四次热切换均 ready，记录 291/296/295/300 ms；第一次 ready 瞬间输入仍暂禁，后续 settled 可用，不能以连接 ready 瞬时值保证整个 composer 已完成更新。此优化仍接收当前 snapshot，不声称消除冷启动广播或大历史内存峰值。

未读对照：通过桌面 `set_thread_read_state(read=false)` 将专用 D 标未读后，桌面持久化与 H5 蓝点均立即为 true，证明 H5 对桌面权威状态的投影可用；随后已通过桌面工具恢复已读。H5 当前仅在选中行本地移除蓝点，选中 D 后并未清除桌面持久化未读，跨端已读同样需要修复。失败候选的完成通知在 native 日志出现同毫秒的 `Received broadcast but no handler is configured`，证明至少部分 Desktop IPC client 收到，仍不能证明专用 read-state 管理器接受通知。源码核验 method v3、conversationId 到 threadId 的映射以及身份/host 校验均一致，未找到可信的单点修复，不伪造桌面未读文件。

核对基线为 `1f6f54b`，H5 版本为 `20261108-stable26`。本记录区分公网资源、浏览器交互、隔离测试和安装包；不将旧页面结果或模拟模型结果记为当前完整验收通过。主代理负责本轮桌面真实 UI 双向收发、归档/删除和快速切换，本核对没有重复操作这些流程。

现有 `stable-candidate-2026-11-07.md`、`OWNER-MODEL-VALIDATION-20261107.md` 等是历史记录。其中“线上仍为旧版”“暂未切换”和早期文件哈希不代表本轮线上状态；182 项测试通过也不是当前 HEAD 的全量回归结果。

| 核对项 | 状态与证据 | 实际能证明的范围 |
| --- | --- | --- |
| 公网根 HTML、JS、CSS | PASS，三项 HTTP 200，与 HEAD 文件 SHA-256 一致。根 HTML 两处版本均为 stable26；三个响应均为 `cache-control: no-store`。回执 `/private/tmp/codex-stable26-readonly-public-check.json` | 已上线正确静态资源；本检查没有手机 Cookie，未证明已打开页面采用新脚本 |
| 列表错误保留、请求合并、恢复输入框及历史 UI | PASS，本轮执行 `node --test test/history-auto-recovery-ui.test.mjs test/optimistic-send.test.mjs test/recorded-history-ui.test.mjs`，33 项通过，无失败/跳过 | VM DOM fixture；包含同 scope 最大一个在途请求、最多一次补发、最新 visible/handover、401/403、切设备旧请求隔离。不是公网快速切换验收 |
| IPC 与相关回归 | 已有日志 PASS，`/private/tmp/codex-stable26-targeted-tests.log` 为 49/49，`/private/tmp/codex-stable26-integration-tests.log` 为 21/21 | 两份日志均早于最后的 H5 提交；用例可能重叠，不能相加为“70 个不同测试”，也不能代替最后 H5 的回归 |
| 原全量测试 | 历史 PASS，`/private/tmp/codex-stable-final-tests.log` 为 182/182 | 修改 IPC 池及最后 H5 补丁前的结果，不是当前 HEAD 全量结果；本轮没有重复全量测试 |
| Mac IPC 池运行模块 | PASS，`stable26-ipcpool.noindex` 包内的 `ipc-pool.mjs`、`session.mjs`、`owner-runtime.mjs`、`relay/server.mjs` 与当前源码哈希一致；已有 build 日志含构建成功 | 对已检查模块的静态一致性，不是完整安装包验收 |
| Mac 随包 H5 一致性 | 未通过当前源码一致性核对：包内 `public/desktop.js`、`desktop.html` 与 HEAD 不同；CSS 相同 | 远程 H5 更新不要求重建电脑运行模块，但最终按当前 HEAD 分发安装包前，应同步文件并重签/校验，或明确记录安装包的源码基线 |
| 旧快速切换记录 | 已复现失败，`/private/tmp/codex-stable26-rapid-switch-records.json` 共 65 条，最后 `i=64` 报 `task list missing` | 文件时间 16:09，早于 16:27 的本次上传回执；文件名带 stable26 仍不能证明最后列表修复已复验 |
| 旧连接与布局记录 | 已有局部 live 证据：`connect-small.json` 中 B/C/D 均连接成功，`connect-warm.json` 热切换约 315–321 ms；stable24 布局记录中加号/模型按钮/发送按钮中心均为 y=771，文字与发送图标间距 14 px | 连接性能与布局的早期观察。冷切换存在约 6–11 s 的记录；不能只引用热切换数字。布局和输入框仍应在新页面观察 |

公网文件 SHA-256：HTML `24c1af5674e609255201c2ec66a366baf445d69e917a925c962cc03adc308964`；JS `0c5762364e31cf74238b23935fcae66de7652251fe79cb34102b755d608281d4`；CSS `990d074d0fcb520a32fdfeb6ae85360ec8598d1cdec374bbb4beec71caa2c23a`。

剩余验收应先完成当前页面刷新，确认网络加载的 JS 是上述 stable26 内容，再沿用同一专用聊天做短路径复验。最新的双向收发、归档/删除和 rapid switch 由主代理补记录。本核对尚无这些流程在刷新后完成的证据，不写 PASS。

列表专项应观察一次连续切换和一次暂时 503/断连：原任务按钮可继续点击，只保留一条重试提示，恢复后提示移除；同 scope 的 `/api/threads` 请求不重叠，合并补发使用最后选中聊天和 handover。不要为复现错误替换正式电脑配对。运行任务切走后的转圈、完成后的未读、切回后的状态清除还需完整过程证据；现有 `run-unread-start.json` 只记录开始与切走，没有完成结果。

模型/强度/计划模式切换、排队发送、停止、首次附件发送及图片/PDF/文件预览有隔离或历史浏览器证据，但这里尚未核对到最后页面的完整公网交互结果。审批、问答、工具/子代理/文件差异展示的自动化证据也不能扩写为真实桌面 UI 已验收。若本轮要求覆盖这些功能，应在专用任务中各验证一条代表路径，并分别记录触发、操作和最终状态。

两台真实 iPhone 恢复配对、Safari/主屏幕安全区与键盘、真实相机扫码、真实网络附件耗时仍无本轮证据。用户已允许先以浏览器验收；可以明确保留这些真机未验项，不能用 Canvas 相机、模拟视口或临时 relay 的成功替代。Windows 本轮新能力同样未验。

以下命令仅用于针对性复验或查阅，不建议在已有通过日志后无条件再跑全部测试。均从仓库根目录执行。

```sh
# 最新列表修复：只需这一个文件即可验证其 18 项 UI 用例。
node --test test/history-auto-recovery-ui.test.mjs

# 如 IPC/连接器后续再修改，回归共享连接、租约与控制写边界。
node --test test/desktop-ipc-pool.test.mjs test/desktop-ipc.test.mjs

# 如需补隔离 CLI 的新建/模型/恢复闭环，输出使用模拟模型，不能标成桌面 UI。
node --test test/phone-flow.e2e.test.mjs

# 查看现有日志结尾，不重新运行全量测试。
tail -n 9 /private/tmp/codex-stable26-targeted-tests.log
tail -n 9 /private/tmp/codex-stable26-integration-tests.log

# 快速核对公开页面版本与线上脚本哈希，无需手机凭据。
curl --fail --silent --show-error --max-time 12 https://codex.air-inc.top/ | rg 'desktop\.(js|css)\?v='
curl --fail --silent --show-error --max-time 12 'https://codex.air-inc.top/desktop.js?v=20261108-stable26' | shasum -a 256

# 已有 Mac 包签名校验；不修改或重新签名。
codesign --verify --deep --strict '/private/tmp/codex-phone-stable26-ipcpool.noindex/codex手机助手.app'
```

如果需要独立的浏览器附件/停止 fixture，可运行 `node scripts/phone-browser-fixture.mjs`，再访问进程输出的 loopback URL。该脚本使用临时数据和模拟模型；它不证明正式服务、真实模型或 iPhone 兼容性，也不应额外开启来重复主代理正在进行的公网验收。
